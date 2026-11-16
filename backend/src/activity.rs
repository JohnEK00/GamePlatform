//! Activity-event writers for the F002 feed (API.md § F002 "Event production").
//!
//! Each writer runs **after** the triggering write succeeded, on the caller's connection
//! (inside its transaction when it has one). The writer's statements run in a nested
//! transaction (a SAVEPOINT when the caller is already in one), so a failure rolls back only
//! the event write: it is logged with `tracing::warn!` and never fails the request. SQLite
//! keeps the outer transaction usable after a failed statement.

use chrono::{DateTime, Duration, Utc};
use sqlx::pool::PoolConnection;
use sqlx::{Connection, Sqlite, SqliteConnection, SqlitePool};

pub const KIND_GAME_PUBLISHED: &str = "gamePublished";
pub const KIND_GAME_UPDATED: &str = "gameUpdated";
pub const KIND_PERSONAL_BEST: &str = "personalBest";
pub const KIND_ACHIEVEMENT: &str = "achievementUnlocked";
pub const KINDS: [&str; 4] = [
    KIND_GAME_PUBLISHED,
    KIND_GAME_UPDATED,
    KIND_PERSONAL_BEST,
    KIND_ACHIEVEMENT,
];

/// `gameUpdated` rows for the same game within this window are replaced.
pub const UPDATE_COALESCE_HOURS: i64 = 24;

fn stamp(now: DateTime<Utc>) -> (String, String) {
    (
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        now.format("%Y-%m-%d").to_string(),
    )
}

fn log_failure(kind: &str, game_id: &str, res: Result<(), sqlx::Error>) {
    if let Err(e) = res {
        tracing::warn!(kind, game_id, error = %e, "failed to record activity event");
    }
}

/// A pooled connection for a writer, or `None` (logged) when none can be acquired.
pub async fn acquire(pool: &SqlitePool) -> Option<PoolConnection<Sqlite>> {
    match pool.acquire().await {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::warn!(error = %e, "no connection for activity event");
            None
        }
    }
}

/// `gamePublished`: the game became published for the first time (the caller guarantees this
/// via `games.first_published_at`).
pub async fn record_game_published(
    conn: &mut SqliteConnection,
    game_id: &str,
    owner_id: &str,
    version: i64,
) {
    let res = async {
        let (now, day) = stamp(Utc::now());
        let mut tx = conn.begin().await?;
        sqlx::query(
            "INSERT INTO activity_events (actor_id, kind, game_id, version, day, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(owner_id)
        .bind(KIND_GAME_PUBLISHED)
        .bind(game_id)
        .bind(version)
        .bind(day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_GAME_PUBLISHED, game_id, res);
}

/// `gameUpdated`: a bundle replace of a published game. Replaces any `gameUpdated` row for the
/// same game from the last 24h.
pub async fn record_game_updated(
    conn: &mut SqliteConnection,
    game_id: &str,
    owner_id: &str,
    version: i64,
) {
    let res = async {
        let now_dt = Utc::now();
        let (now, day) = stamp(now_dt);
        let (cutoff, _) = stamp(now_dt - Duration::hours(UPDATE_COALESCE_HOURS));
        let mut tx = conn.begin().await?;
        // F004: remember the lowest version covered by the coalesced rows.
        let covered: Vec<Option<i64>> = sqlx::query_scalar(
            "DELETE FROM activity_events WHERE game_id = ? AND kind = ? AND created_at >= ? \
             RETURNING COALESCE(from_version, version)",
        )
        .bind(game_id)
        .bind(KIND_GAME_UPDATED)
        .bind(cutoff)
        .fetch_all(&mut *tx)
        .await?;
        let from_version = covered.into_iter().flatten().fold(version, i64::min);
        sqlx::query(
            "INSERT INTO activity_events \
             (actor_id, kind, game_id, version, from_version, day, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(owner_id)
        .bind(KIND_GAME_UPDATED)
        .bind(game_id)
        .bind(version)
        .bind(from_version)
        .bind(day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_GAME_UPDATED, game_id, res);
}

/// `personalBest`: one row per (actor, game, UTC day); the latest replaces earlier ones.
/// `first` is whether this score was the actor's first on the game.
pub async fn record_personal_best(
    conn: &mut SqliteConnection,
    actor_id: &str,
    game_id: &str,
    score: i64,
    first: bool,
) {
    let res = async {
        let (now, day) = stamp(Utc::now());
        let mut tx = conn.begin().await?;
        sqlx::query(
            "DELETE FROM activity_events \
             WHERE actor_id = ? AND game_id = ? AND kind = ? AND day = ?",
        )
        .bind(actor_id)
        .bind(game_id)
        .bind(KIND_PERSONAL_BEST)
        .bind(&day)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO activity_events \
             (actor_id, kind, game_id, score, first_score, day, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(actor_id)
        .bind(KIND_PERSONAL_BEST)
        .bind(game_id)
        .bind(score)
        .bind(first as i64)
        .bind(&day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_PERSONAL_BEST, game_id, res);
}

/// `achievementUnlocked`: one row per (actor, game, UTC day), carrying the latest achievement
/// and `ach_count` = unlocks that day.
pub async fn record_achievement(
    conn: &mut SqliteConnection,
    actor_id: &str,
    game_id: &str,
    ach_id: &str,
) {
    let res = async {
        let (now, day) = stamp(Utc::now());
        let mut tx = conn.begin().await?;
        let prev: Vec<i64> = sqlx::query_scalar(
            "DELETE FROM activity_events \
             WHERE actor_id = ? AND game_id = ? AND kind = ? AND day = ? RETURNING ach_count",
        )
        .bind(actor_id)
        .bind(game_id)
        .bind(KIND_ACHIEVEMENT)
        .bind(&day)
        .fetch_all(&mut *tx)
        .await?;
        let count = prev.into_iter().max().unwrap_or(0) + 1;
        sqlx::query(
            "INSERT INTO activity_events \
             (actor_id, kind, game_id, ach_id, ach_count, day, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(actor_id)
        .bind(KIND_ACHIEVEMENT)
        .bind(game_id)
        .bind(ach_id)
        .bind(count)
        .bind(&day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_ACHIEVEMENT, game_id, res);
}
