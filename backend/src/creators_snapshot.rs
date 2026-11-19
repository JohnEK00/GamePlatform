//! Review 12 M1: periodic in-memory snapshot of the F035 creator rows, serving
//! `GET /api/creators` and the F032 `GET /api/creators/spotlight`.
//!
//! Computing the creator list means one pass over every published game, a follower count per
//! creator and a full sort, which costs tens of milliseconds per request on a large catalogue
//! (REVIEW-2026-11-19-12 M1). Instead, the rows are computed once per refresh with
//! [`crate::routes::creators::creator_sql`], pre-sorted for the three F035 orders and kept in
//! memory behind an `Arc`. Requests clone the `Arc`, slice their page and compute only
//! `isFollowing` for the page's ids (one query).
//!
//! Freshness (the same pattern as F003 [`crate::trending`]):
//! - `CREATORS_TTL_SECS` (default [`crate::config::DEFAULT_CREATORS_TTL_SECS`] = 60) > 0: the
//!   snapshot is built at startup and then by a background task every TTL. New creators, new
//!   or unpublished games, plays, follower counts and profile changes (name, avatar, banner,
//!   bio) show up on these two endpoints after the next refresh, so at most one TTL late.
//! - `CREATORS_TTL_SECS = 0`: no background task; every read rebuilds the snapshot inline
//!   first (tests and development).
//! - If no snapshot was ever built (the startup refresh failed), a read builds one inline.
//! - Refreshes are single flight; a failed refresh keeps the previous snapshot and backs off
//!   for [`crate::trending::FAILURE_BACKOFF`].

use std::cmp::Ordering as CmpOrdering;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use sqlx::{Row, SqlitePool};

use crate::AppState;
use crate::models::{banner_url, user_ref_from_row};
use crate::routes::creators::{Creator, CreatorSort, creator_sql};
use crate::trending::FAILURE_BACKOFF;

/// One computed creator row, as served (with `is_following = false`).
#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub creator: Creator,
    /// `users.username_lower`, the final tie-break of every order.
    pub username_lower: String,
}

/// An immutable snapshot: the rows ordered by user id ascending (the F032 spotlight order),
/// plus the row indexes in each F035 order.
#[derive(Debug, Default)]
pub struct CreatorsSnapshot {
    rows: Vec<SnapshotRow>,
    popular: Vec<usize>,
    active: Vec<usize>,
    new: Vec<usize>,
}

fn by_name(a: &SnapshotRow, b: &SnapshotRow) -> CmpOrdering {
    a.username_lower.cmp(&b.username_lower)
}

impl CreatorsSnapshot {
    /// Build from rows in any order. The comparisons are the F035 `ORDER BY` strings: SQLite's
    /// default BINARY collation compares UTF-8 bytes, which is Rust's `str` order.
    pub fn from_rows(mut rows: Vec<SnapshotRow>) -> Self {
        rows.sort_by(|a, b| a.creator.user.id.cmp(&b.creator.user.id));
        let order = |cmp: &dyn Fn(&SnapshotRow, &SnapshotRow) -> CmpOrdering| {
            let mut idx: Vec<usize> = (0..rows.len()).collect();
            idx.sort_by(|&a, &b| cmp(&rows[a], &rows[b]));
            idx
        };
        let popular = order(&|a, b| {
            b.creator
                .followers
                .cmp(&a.creator.followers)
                .then(b.creator.plays.cmp(&a.creator.plays))
                .then_with(|| by_name(a, b))
        });
        let active = order(&|a, b| {
            b.creator
                .last_active_at
                .cmp(&a.creator.last_active_at)
                .then_with(|| by_name(a, b))
        });
        let new = order(&|a, b| {
            b.creator
                .first_published_at
                .cmp(&a.creator.first_published_at)
                .then_with(|| by_name(a, b))
        });
        Self {
            rows,
            popular,
            active,
            new,
        }
    }

    /// Number of creators (the F035 `total`, the F032 `N`).
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// One page in `sort` order (`offset` and `limit` are clamped to the snapshot).
    pub fn page(&self, sort: CreatorSort, offset: i64, limit: i64) -> Vec<Creator> {
        let idx = match sort {
            CreatorSort::Popular => &self.popular,
            CreatorSort::Active => &self.active,
            CreatorSort::New => &self.new,
        };
        let start = usize::try_from(offset.max(0))
            .unwrap_or(usize::MAX)
            .min(idx.len());
        let len = usize::try_from(limit.max(0)).unwrap_or(usize::MAX);
        idx[start..]
            .iter()
            .take(len)
            .map(|&i| self.rows[i].creator.clone())
            .collect()
    }

    /// The creator at `index` in user-id order (F032 spotlight).
    pub fn by_id_index(&self, index: usize) -> Option<Creator> {
        self.rows.get(index).map(|r| r.creator.clone())
    }
}

/// Compute the snapshot rows (one statement: [`creator_sql`] without a limit).
pub async fn load(db: &SqlitePool) -> sqlx::Result<CreatorsSnapshot> {
    let rows = sqlx::query(&creator_sql(false, "u.id ASC"))
        .bind(-1_i64)
        .bind(0_i64)
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let user = user_ref_from_row(r, "u_")?;
        let banner_ext: Option<String> = r.try_get("banner_ext")?;
        let banner_version: i64 = r.try_get("banner_version")?;
        let bio: Option<String> = r.try_get("bio_excerpt")?;
        out.push(SnapshotRow {
            username_lower: r.try_get("u_username_lower")?,
            creator: Creator {
                banner_url: banner_url(&user.id, banner_ext.as_deref(), banner_version),
                user,
                bio_excerpt: bio.unwrap_or_default(),
                games: r.try_get("games")?,
                plays: r.try_get("plays")?,
                followers: r.try_get("followers")?,
                is_following: false,
                first_published_at: r.try_get("first_pub")?,
                last_active_at: r.try_get("last_act")?,
            },
        });
    }
    Ok(CreatorsSnapshot::from_rows(out))
}

#[derive(Default)]
struct Inner {
    snapshot: RwLock<Option<Arc<CreatorsSnapshot>>>,
    last: Mutex<Option<Instant>>,
    last_failure: Mutex<Option<Instant>>,
    flight: tokio::sync::Mutex<()>,
    refreshes: AtomicU64,
    failures: AtomicU64,
}

/// Process-wide creator snapshot (in `AppState`).
#[derive(Clone, Default)]
pub struct CreatorsCache {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl CreatorsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Successful refreshes since startup (observability and tests).
    pub fn refresh_count(&self) -> u64 {
        self.inner.refreshes.load(Ordering::Relaxed)
    }

    /// Failed refreshes since startup.
    pub fn failure_count(&self) -> u64 {
        self.inner.failures.load(Ordering::Relaxed)
    }

    /// The current snapshot (`None` before the first successful refresh).
    pub fn current(&self) -> Option<Arc<CreatorsSnapshot>> {
        self.inner
            .snapshot
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn is_fresh(&self, ttl: std::time::Duration) -> bool {
        lock(&self.inner.last).is_some_and(|t| t.elapsed() < ttl)
    }

    fn in_backoff(&self) -> bool {
        lock(&self.inner.last_failure).is_some_and(|t| t.elapsed() < FAILURE_BACKOFF)
    }

    /// Rebuild now (single flight with any other caller). Returns `true` on success; a failure
    /// is logged, keeps the previous snapshot and starts the backoff. Tests call this to force
    /// a refresh.
    pub async fn refresh_now(&self, db: &SqlitePool) -> bool {
        let _flight = self.inner.flight.lock().await;
        self.run_locked(db).await
    }

    async fn run_locked(&self, db: &SqlitePool) -> bool {
        match load(db).await {
            Ok(s) => {
                *self
                    .inner
                    .snapshot
                    .write()
                    .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(s));
                *lock(&self.inner.last) = Some(Instant::now());
                *lock(&self.inner.last_failure) = None;
                self.inner.refreshes.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(e) => {
                *lock(&self.inner.last_failure) = Some(Instant::now());
                self.inner.failures.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = %e, "creators refresh failed; serving stale snapshot");
                false
            }
        }
    }

    /// Rebuild when older than `ttl` (or never built), unless in backoff. Concurrent callers
    /// wait for the running rebuild and re-check.
    pub async fn ensure_fresh_with(&self, db: &SqlitePool, ttl: std::time::Duration) {
        if self.is_fresh(ttl) || self.in_backoff() {
            return;
        }
        let _flight = self.inner.flight.lock().await;
        if self.is_fresh(ttl) || self.in_backoff() {
            return;
        }
        self.run_locked(db).await;
    }
}

/// Request-path read: with `CREATORS_TTL_SECS = 0` rebuild inline first; otherwise use the
/// snapshot as it is (built inline only if none exists yet). Empty when no snapshot could be
/// built at all (the error was logged).
pub async fn snapshot(state: &AppState) -> Arc<CreatorsSnapshot> {
    let cache = &state.creators;
    let ttl = state.config.creators_ttl;
    if ttl.is_zero() {
        cache
            .ensure_fresh_with(&state.db, std::time::Duration::ZERO)
            .await;
    } else if cache.current().is_none() {
        cache.ensure_fresh_with(&state.db, ttl).await;
    }
    cache.current().unwrap_or_default()
}

/// Background refresh every `CREATORS_TTL_SECS` (retrying after `min(TTL, FAILURE_BACKOFF)`
/// on failure); `None` when the TTL is 0. Startup already refreshed in `AppState::new`.
pub fn spawn_refresh(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    let ttl = state.config.creators_ttl;
    (!ttl.is_zero()).then(|| {
        let db = state.db.clone();
        let cache = state.creators.clone();
        tokio::spawn(async move {
            let mut wait = ttl;
            loop {
                tokio::time::sleep(wait).await;
                wait = if cache.refresh_now(&db).await {
                    ttl
                } else {
                    ttl.min(FAILURE_BACKOFF)
                };
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::UserRef;

    fn row(
        id: &str,
        name: &str,
        followers: i64,
        plays: i64,
        first: &str,
        last: &str,
    ) -> SnapshotRow {
        SnapshotRow {
            username_lower: name.to_string(),
            creator: Creator {
                user: UserRef {
                    id: id.into(),
                    username: name.into(),
                    display_name: name.into(),
                    avatar_url: None,
                },
                banner_url: None,
                bio_excerpt: String::new(),
                games: 1,
                plays,
                followers,
                is_following: false,
                first_published_at: first.into(),
                last_active_at: last.into(),
            },
        }
    }

    fn names(v: &[Creator]) -> Vec<&str> {
        v.iter().map(|c| c.user.username.as_str()).collect()
    }

    #[test]
    fn orders_and_paging() {
        let s = CreatorsSnapshot::from_rows(vec![
            row("c", "carl", 1, 5, "2026-01-03", "2026-02-01"),
            row("a", "anna", 2, 0, "2026-01-01", "2026-02-01"),
            row("b", "bob", 1, 9, "2026-01-03", "2026-03-01"),
        ]);
        assert_eq!(s.len(), 3);
        assert_eq!(
            names(&s.page(CreatorSort::Popular, 0, 10)),
            ["anna", "bob", "carl"]
        );
        assert_eq!(
            names(&s.page(CreatorSort::Active, 0, 10)),
            ["bob", "anna", "carl"]
        );
        assert_eq!(
            names(&s.page(CreatorSort::New, 0, 10)),
            ["bob", "carl", "anna"]
        );
        assert_eq!(names(&s.page(CreatorSort::Popular, 1, 1)), ["bob"]);
        assert!(s.page(CreatorSort::Popular, 3, 10).is_empty());
        assert!(s.page(CreatorSort::Popular, i64::MAX, 10).is_empty());
        assert_eq!(s.by_id_index(0).unwrap().user.id, "a");
        assert_eq!(s.by_id_index(2).unwrap().user.id, "c");
        assert!(s.by_id_index(3).is_none());
        assert!(CreatorsSnapshot::default().is_empty());
    }
}
