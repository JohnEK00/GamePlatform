//! F003 trending snapshot (docs/ARCHITECTURE.md § F003).
//!
//! `game_trending` holds one row per game with counted non-owner plays in the last 7 UTC days.
//! It is refreshed lazily (at startup, and when a `sort=trending` or `/related` read finds it
//! older than `TRENDING_TTL_SECS`), single flight, and a failed refresh serves the stale data.

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

/// Recompute `game_trending` for the window ending on `now`'s UTC day, then null viewer keys
/// older than the window. One transaction.
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
    sqlx::query(
        "UPDATE play_events SET viewer_key = NULL WHERE day < ?1 AND viewer_key IS NOT NULL",
    )
    .bind(&first_s)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

#[derive(Default)]
struct Inner {
    /// When the last successful refresh finished (`None` = none since startup).
    last: Mutex<Option<Instant>>,
    /// Single-flight lock: one refresh at a time.
    flight: tokio::sync::Mutex<()>,
    /// Number of successful refreshes (observability and tests).
    refreshes: AtomicU64,
}

/// Process-wide trending snapshot freshness tracker (in `AppState`).
#[derive(Clone, Default)]
pub struct TrendingCache {
    inner: Arc<Inner>,
}

impl TrendingCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of successful refreshes run through this cache since startup.
    pub fn refresh_count(&self) -> u64 {
        self.inner.refreshes.load(Ordering::Relaxed)
    }

    fn is_fresh(&self, ttl: std::time::Duration) -> bool {
        let last = self.inner.last.lock().unwrap_or_else(|p| p.into_inner());
        last.is_some_and(|t| t.elapsed() < ttl)
    }

    /// Refresh the snapshot when it is older than `ttl` (or never refreshed). Concurrent
    /// callers wait for the running refresh and re-check. Failures are logged; the stale
    /// snapshot stays in place.
    pub async fn ensure_fresh_with(&self, db: &SqlitePool, ttl: std::time::Duration) {
        if self.is_fresh(ttl) {
            return;
        }
        let _flight = self.inner.flight.lock().await;
        if self.is_fresh(ttl) {
            return;
        }
        match refresh(db, Utc::now()).await {
            Ok(()) => {
                *self.inner.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
                self.inner.refreshes.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => tracing::warn!(error = %e, "trending refresh failed; serving stale snapshot"),
        }
    }
}

/// [`TrendingCache::ensure_fresh_with`] for the app state (TTL from `TRENDING_TTL_SECS`).
pub async fn ensure_fresh(state: &AppState) {
    state
        .trending
        .ensure_fresh_with(&state.db, state.config.trending_ttl)
        .await;
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
