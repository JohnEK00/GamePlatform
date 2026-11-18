//! Activity-event writers for the F002 feed (API.md § F002 "Event production").
//!
//! Each writer runs **after** the triggering write succeeded, on the caller's connection
//! (inside its transaction when it has one). The writer's statements run in a nested
//! transaction (a SAVEPOINT when the caller is already in one), so a failure rolls back only
//! the event write: it is logged with `tracing::warn!` and never fails the request. SQLite
//! keeps the outer transaction usable after a failed statement.
//!
//! Since F021 (migration `0019_f021.sql`) `activity_events.kind` has no CHECK constraint:
//! [`KINDS`] is the only guard on the stored kinds, as `notifications::Kind` is for
//! notifications. Every writer here uses one of its constants.

use chrono::{DateTime, Duration, Utc};
use sqlx::pool::PoolConnection;
use sqlx::{Connection, Sqlite, SqliteConnection, SqlitePool};

pub const KIND_GAME_PUBLISHED: &str = "gamePublished";
pub const KIND_GAME_UPDATED: &str = "gameUpdated";
pub const KIND_PERSONAL_BEST: &str = "personalBest";
pub const KIND_ACHIEVEMENT: &str = "achievementUnlocked";
/// F021: a curator added published games to a public collection (one row per collection and
/// UTC day; `game_id` NULL, `collection_id` and `game_ids` set).
pub const KIND_COLLECTION_UPDATED: &str = "collectionUpdated";
/// F015: someone posted screenshots of a published game (one row per actor, game and UTC day;
/// the shots are found at read time, the row stores no screenshot ids).
pub const KIND_SCREENSHOT_POSTED: &str = "screenshotPosted";
/// F030: a user created a post (one row per post, no coalescing; `game_id` and
/// `collection_id` NULL, `post_id` set; the row cascades with the post).
pub const KIND_POST_CREATED: &str = "postCreated";
pub const KINDS: [&str; 7] = [
    KIND_GAME_PUBLISHED,
    KIND_GAME_UPDATED,
    KIND_PERSONAL_BEST,
    KIND_ACHIEVEMENT,
    KIND_COLLECTION_UPDATED,
    KIND_SCREENSHOT_POSTED,
    KIND_POST_CREATED,
];

/// F021: at most this many game ids in one `collectionUpdated` row's `game_ids`.
pub const COLLECTION_EVENT_GAMES_MAX: usize = 100;

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

/// F021 `game_ids` of a coalesced `collectionUpdated` row: `game_id` first, then the ids of
/// every earlier array in order, without `game_id` and without duplicates, truncated to
/// [`COLLECTION_EVENT_GAMES_MAX`]. Unparseable arrays count as empty.
pub fn merge_collection_game_ids(game_id: &str, previous: &[Option<String>]) -> Vec<String> {
    let mut merged = vec![game_id.to_string()];
    for raw in previous.iter().flatten() {
        let ids: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
        for id in ids {
            if merged.len() >= COLLECTION_EVENT_GAMES_MAX {
                return merged;
            }
            if !merged.contains(&id) {
                merged.push(id);
            }
        }
    }
    merged.truncate(COLLECTION_EVENT_GAMES_MAX);
    merged
}

/// F021 `collectionUpdated`: one row per (collection, UTC day). Each announced add replaces
/// the day's row (new, higher id) and puts the game first. `now` is the exact `added_at` just
/// written; its first 10 characters are the day. The caller checked, in the same transaction,
/// that the collection is public and the game published.
pub async fn record_collection_added(
    conn: &mut SqliteConnection,
    actor_id: &str,
    collection_id: &str,
    game_id: &str,
    now: &str,
) {
    let res = async {
        let day = now.get(..10).unwrap_or(now);
        let mut tx = conn.begin().await?;
        let previous: Vec<Option<String>> = sqlx::query_scalar(
            "DELETE FROM activity_events              WHERE collection_id = ?1 AND kind = 'collectionUpdated' AND day = ?2              RETURNING game_ids",
        )
        .bind(collection_id)
        .bind(day)
        .fetch_all(&mut *tx)
        .await?;
        let merged = merge_collection_game_ids(game_id, &previous);
        let merged = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "INSERT INTO activity_events              (actor_id, kind, game_id, collection_id, game_ids, day, created_at)              VALUES (?3, 'collectionUpdated', NULL, ?1, ?4, ?2, ?5)",
        )
        .bind(collection_id)
        .bind(day)
        .bind(actor_id)
        .bind(merged)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_COLLECTION_UPDATED, game_id, res);
}

/// F015 `screenshotPosted`: one row per (actor, game, UTC day). Each post replaces the day's
/// row (new, higher id). `now` is the exact `created_at` bound in the screenshot insert; its
/// first 10 characters are the day. The caller checked that the game was published; the game
/// owner is not excluded.
pub async fn record_screenshot_posted(
    conn: &mut SqliteConnection,
    actor_id: &str,
    game_id: &str,
    now: &str,
) {
    let res = async {
        let day = now.get(..10).unwrap_or(now);
        let mut tx = conn.begin().await?;
        sqlx::query(
            "DELETE FROM activity_events \
             WHERE actor_id = ?1 AND game_id = ?2 AND kind = 'screenshotPosted' AND day = ?3",
        )
        .bind(actor_id)
        .bind(game_id)
        .bind(day)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO activity_events (actor_id, kind, game_id, day, created_at) \
             VALUES (?1, 'screenshotPosted', ?2, ?3, ?4)",
        )
        .bind(actor_id)
        .bind(game_id)
        .bind(day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_SCREENSHOT_POSTED, game_id, res);
}

/// F030 `postCreated`: one row per post, written inside `create_post`'s transaction right after
/// the guarded insert. `now` is the exact `created_at` bound in the post insert; its first 10
/// characters are the day.
pub async fn record_post_created(
    conn: &mut SqliteConnection,
    actor_id: &str,
    post_id: &str,
    now: &str,
) {
    let res = async {
        let day = now.get(..10).unwrap_or(now);
        let mut tx = conn.begin().await?;
        sqlx::query(
            "INSERT INTO activity_events (actor_id, kind, post_id, day, created_at) \
             VALUES (?1, 'postCreated', ?2, ?3, ?4)",
        )
        .bind(actor_id)
        .bind(post_id)
        .bind(day)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
    .await;
    log_failure(KIND_POST_CREATED, post_id, res);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_puts_the_new_game_first_without_duplicates() {
        let prev = vec![
            Some(r#"["b","a"]"#.to_string()),
            None,
            Some("not json".to_string()),
            Some(r#"["c","b"]"#.to_string()),
        ];
        assert_eq!(merge_collection_game_ids("a", &prev), ["a", "b", "c"]);
        let many: Vec<String> = (0..150).map(|i| format!("g{i}")).collect();
        let prev = vec![Some(serde_json::to_string(&many).unwrap())];
        let merged = merge_collection_game_ids("new", &prev);
        assert_eq!(merged.len(), COLLECTION_EVENT_GAMES_MAX);
        assert_eq!(merged[0], "new");
        assert_eq!(merged[1], "g0");
        assert_eq!(KINDS.len(), 7);
        assert!(KINDS.contains(&KIND_COLLECTION_UPDATED));
        assert!(KINDS.contains(&KIND_SCREENSHOT_POSTED));
        assert!(KINDS.contains(&KIND_POST_CREATED));
    }
}
