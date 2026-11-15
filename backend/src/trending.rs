//! F003 trending snapshot (docs/ARCHITECTURE.md § F003).
//!
//! `game_trending` holds one row per game with counted non-owner plays in the last 7 UTC days.
//! It is refreshed at startup and then by a background task every `TRENDING_TTL_SECS`
//! (REVIEW-2026-11-14-2 N3); requests only read it. `TRENDING_TTL_SECS=0` instead refreshes
//! inline on every `sort=trending` / `/related` read (tests). Refreshes are single flight, a
//! failed refresh keeps the stale data and backs off for [`FAILURE_BACKOFF`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::AppState;
use crate::config::Config;

/// Number of UTC days in the trending window (today included).
pub const WINDOW_DAYS: i64 = 7;

/// Viewer identity stored on counted plays: `u:<userId>` when signed in, else `a:` plus the
/// first 16 hex chars of `SHA-256(JWT_SECRET + "|play|" + clientIp)`.
pub fn viewer_key(config: &Config, user_id: Option<&str>, client_ip: &str) -> String {
    match user_id {
        Some(id) => format!("u:{id}"),
        None => {
            let mut h = Sha256::new();
            h.update(config.jwt_secret.as_bytes());
            h.update(b"|play|");
            h.update(client_ip.as_bytes());
            let digest = h.finalize();
            let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
            format!("a:{hex}")
        }
    }
}

/// Weight of a day `age` days before today (0 = today): `(7 - age) / 7`; 0 outside the window.
pub fn day_weight(age: i64) -> f64 {
    if (0..WINDOW_DAYS).contains(&age) {
        (WINDOW_DAYS - age) as f64 / WINDOW_DAYS as f64
    } else {
        0.0
    }
}

/// Related-games tag weight: `1 / log2(2 + n)` for a tag used by `n` published games.
pub fn tag_weight(n: i64) -> f64 {
    1.0 / (2.0 + n.max(0) as f64).log2()
}

/// Recompute `game_trending` for the window ending on `now`'s UTC day (one transaction), then
/// null viewer keys older than the window (a second, short transaction). The purge goes
/// through the partial index `idx_play_events_viewer_key_day` (migration 0008, N3), so it only
/// visits rows that still hold a key instead of all play history.
pub async fn refresh(db: &SqlitePool, now: DateTime<Utc>) -> sqlx::Result<()> {
    let today = now.date_naive();
    let first = today - ChronoDuration::days(WINDOW_DAYS - 1);
    let first_s = first.format("%Y-%m-%d").to_string();
    let today_s = today.format("%Y-%m-%d").to_string();
    let now_s = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM game_trending")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO game_trending (game_id, plays_week, score, computed_at) \
         SELECT d.game_id, SUM(d.plays), \
                SUM(d.viewers * (7.0 - (julianday(?2) - julianday(d.day))) / 7.0), ?3 \
         FROM ( \
             SELECT e.game_id, e.day, COUNT(*) AS plays, \
                    COUNT(DISTINCT COALESCE(e.viewer_key, 'row:' || e.id)) AS viewers \
             FROM play_events e JOIN games g ON g.id = e.game_id \
             WHERE e.day >= ?1 AND e.day <= ?2 \
               AND (e.user_id IS NULL OR e.user_id <> g.owner_id) \
             GROUP BY e.game_id, e.day \
         ) d \
         GROUP BY d.game_id",
    )
    .bind(&first_s)
    .bind(&today_s)
    .bind(&now_s)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    sqlx::query(PURGE_SQL).bind(&first_s).execute(db).await?;
    Ok(())
}

/// Viewer-key purge (bind: first day of the window).
pub const PURGE_SQL: &str = "UPDATE play_events INDEXED BY idx_play_events_viewer_key_day \
     SET viewer_key = NULL WHERE day < ?1 AND viewer_key IS NOT NULL";

/// After a failed refresh, inline (TTL 0) refreshes are skipped for this long, and the
/// background task retries after `min(TTL, FAILURE_BACKOFF)`.
pub const FAILURE_BACKOFF: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Default)]
struct Inner {
    /// When the last successful refresh finished (`None` = none since startup).
    last: Mutex<Option<Instant>>,
    /// When the last failed refresh finished (`None` = none since the last success).
    last_failure: Mutex<Option<Instant>>,
    /// Single-flight lock: one refresh at a time.
    flight: tokio::sync::Mutex<()>,
    /// Number of successful refreshes (observability and tests).
    refreshes: AtomicU64,
    /// Number of failed refreshes (observability and tests).
    failures: AtomicU64,
}

/// Process-wide trending snapshot freshness tracker (in `AppState`).
#[derive(Clone, Default)]
pub struct TrendingCache {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl TrendingCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of successful refreshes run through this cache since startup.
    pub fn refresh_count(&self) -> u64 {
        self.inner.refreshes.load(Ordering::Relaxed)
    }

    /// Number of failed refreshes run through this cache since startup.
    pub fn failure_count(&self) -> u64 {
        self.inner.failures.load(Ordering::Relaxed)
    }

    fn is_fresh(&self, ttl: std::time::Duration) -> bool {
        lock(&self.inner.last).is_some_and(|t| t.elapsed() < ttl)
    }

    fn in_backoff(&self) -> bool {
        lock(&self.inner.last_failure).is_some_and(|t| t.elapsed() < FAILURE_BACKOFF)
    }

    /// Run one refresh now (single flight with any other caller). Returns `true` on success.
    /// A failure is logged and recorded (backoff); the stale snapshot stays in place.
    pub async fn refresh_now(&self, db: &SqlitePool) -> bool {
        let _flight = self.inner.flight.lock().await;
        self.run_locked(db).await
    }

    async fn run_locked(&self, db: &SqlitePool) -> bool {
        match refresh(db, Utc::now()).await {
            Ok(()) => {
                *lock(&self.inner.last) = Some(Instant::now());
                *lock(&self.inner.last_failure) = None;
                self.inner.refreshes.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(e) => {
                *lock(&self.inner.last_failure) = Some(Instant::now());
                self.inner.failures.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = %e, "trending refresh failed; serving stale snapshot");
                false
            }
        }
    }

    /// Refresh the snapshot when it is older than `ttl` (or never refreshed), unless a refresh
    /// failed within [`FAILURE_BACKOFF`]. Concurrent callers wait for the running refresh and
    /// re-check.
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

/// Request-path hook for `sort=trending` and `/related` reads.
///
/// With `TRENDING_TTL_SECS > 0` (production) this does nothing: the background task from
/// [`spawn_maintenance`] refreshes the snapshot every TTL, and requests read it as it is, so
/// no request ever waits on a refresh. With `TRENDING_TTL_SECS = 0` (tests, development) there
/// is no background task and every such read refreshes inline first (skipped for
/// [`FAILURE_BACKOFF`] after a failure).
pub async fn ensure_fresh(state: &AppState) {
    if state.config.trending_ttl.is_zero() {
        state
            .trending
            .ensure_fresh_with(&state.db, std::time::Duration::ZERO)
            .await;
    }
}

/// F007: minimum interval between notification prunes in [`spawn_maintenance`].
pub const PRUNE_EVERY: std::time::Duration = std::time::Duration::from_secs(3600);

/// Background maintenance (N1, N3): every `TRENDING_TTL_SECS` refresh the trending snapshot
/// (retrying after `min(TTL, FAILURE_BACKOFF)` when it fails) and run `PRAGMA optimize`.
/// The first run is one TTL after the call (startup already refreshed in `AppState::new`).
/// Returns `None` (no task) when the TTL is 0. Call once from `serve`.
pub fn spawn_maintenance(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    let ttl = state.config.trending_ttl;
    if ttl.is_zero() {
        return None;
    }
    let db = state.db.clone();
    let cache = state.trending.clone();
    let state = state.clone();
    Some(tokio::spawn(async move {
        let mut wait = ttl;
        // F007: notification pruning runs at most once per PRUNE_EVERY.
        let mut last_prune: Option<std::time::Instant> = None;
        loop {
            tokio::time::sleep(wait).await;
            wait = if cache.refresh_now(&db).await {
                ttl
            } else {
                ttl.min(FAILURE_BACKOFF)
            };
            crate::db::optimize(&db, false).await;
            // L4: retry `score_bests` rebuilds that failed earlier (a no-op when none).
            let _ = crate::bests::spawn_rebuild(&state).await;
            if last_prune.is_none_or(|t| t.elapsed() >= PRUNE_EVERY) {
                last_prune = Some(std::time::Instant::now());
                match crate::notifications::prune(&db, Utc::now()).await {
                    Ok(n) => tracing::debug!(deleted = n, "pruned notifications"),
                    Err(e) => tracing::warn!(error = %e, "notification pruning failed"),
                }
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_key_shape() {
        let mut c = Config::for_data_dir("x");
        assert_eq!(viewer_key(&c, Some("abc"), "1.2.3.4"), "u:abc");
        let a = viewer_key(&c, None, "1.2.3.4");
        assert!(a.starts_with("a:"));
        assert_eq!(a.len(), 18);
        assert!(
            a[2..]
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        );
        assert_eq!(a, viewer_key(&c, None, "1.2.3.4"), "stable");
        assert_ne!(a, viewer_key(&c, None, "1.2.3.5"));
        assert!(!a.contains("1.2.3.4"));
        c.jwt_secret = "other".into();
        assert_ne!(a, viewer_key(&c, None, "1.2.3.4"), "secret-keyed");
    }

    #[test]
    fn weights() {
        assert_eq!(day_weight(0), 1.0);
        assert!((day_weight(6) - 1.0 / 7.0).abs() < 1e-12);
        assert_eq!(day_weight(7), 0.0);
        assert_eq!(day_weight(-1), 0.0);
        for age in 0..6 {
            assert!(day_weight(age) > day_weight(age + 1));
        }
        assert!((tag_weight(1) - 1.0 / 3f64.log2()).abs() < 1e-12);
        assert!(tag_weight(1) < 0.64);
        assert!((tag_weight(2) - 0.5).abs() < 1e-12);
        for n in 1..50 {
            assert!(tag_weight(n) > tag_weight(n + 1));
        }
    }
}
