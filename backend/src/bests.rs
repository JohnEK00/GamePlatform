//! L4 (REVIEW-2026-11-15-3): deferred `score_bests` rebuilds after a `leaderboard.order` flip.
//!
//! The flip trigger (migration 0011) only records the game in `score_bests_stale`. While a
//! game is stale, boards read [`FALLBACK_SOURCE`] (the bests computed from `scores`, the same
//! order and tie-breaks as the table), so they are always correct. [`rebuild_game`] then
//! rewrites the game's rows in batches of users, one short write transaction per batch, so
//! other writers never queue behind a whole-game rebuild.
//!
//! Correctness while rebuilding: the `scores` triggers keep maintaining `score_bests` with the
//! game's current (new) order. Rows of users that were already rebuilt (or that had no rows)
//! stay exact; rows of users not yet rebuilt are rewritten by a later batch. The stale mark is
//! cleared in the last batch's transaction only when its generation is unchanged, so a newer
//! flip during the rebuild restarts it.

use sqlx::{SqliteConnection, SqlitePool};

use crate::AppState;
use crate::error::AppResult;

/// Users rewritten per transaction.
pub const REBUILD_BATCH_USERS: i64 = 250;

/// `score_bests` columns, in table order.
const COLS: &str =
    "game_id, period, period_start, user_id, score_id, score, rank_score, created_at, score_rowid";

/// `true` while the game's `score_bests` rows await a rebuild.
pub async fn is_stale(conn: &mut SqliteConnection, game_id: &str) -> AppResult<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM score_bests_stale WHERE game_id = ?")
        .bind(game_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(n > 0)
}

/// A `score_bests`-shaped subquery (alias it as `b`) holding the bests of game `?1` in window
/// `?2` (`all|day|week`) / `?3` (period start), computed from `scores` with the game's current
/// order. Same keys, order and tie-breaks as the table, so every board query reads it unchanged.
pub const FALLBACK_SOURCE: &str = "(SELECT game_id, period, period_start, user_id, score_id, \
       score, rank_score, created_at, score_rowid FROM ( \
       SELECT y.*, ROW_NUMBER() OVER (PARTITION BY y.user_id \
         ORDER BY y.rank_score, y.created_at, y.score_rowid) AS rn FROM ( \
         SELECT s.game_id, ?2 AS period, ?3 AS period_start, s.user_id, s.id AS score_id, \
           s.score, CASE WHEN g.score_order = 'asc' THEN s.score ELSE -s.score END AS rank_score, \
           s.created_at, s.rowid AS score_rowid \
         FROM scores s JOIN games g ON g.id = s.game_id \
         WHERE s.game_id = ?1 AND (?2 = 'all' OR (CASE ?2 \
             WHEN 'day' THEN substr(s.created_at, 1, 10) \
             ELSE date(s.created_at, 'weekday 0', '-6 days') END) || 'T00:00:00.000Z' = ?3) \
       ) y) WHERE rn = 1)";

/// Rebuild one batch: users in `(lo, hi]` (or `> lo` when `hi` is `None`) of `game_id`.
async fn rewrite_users(
    conn: &mut SqliteConnection,
    game_id: &str,
    lo: &str,
    hi: Option<&str>,
) -> sqlx::Result<()> {
    // Write first: the transaction holds the write lock from here on.
    sqlx::query(
        "DELETE FROM score_bests WHERE game_id = ?1 AND user_id > ?2 \
         AND (?3 IS NULL OR user_id <= ?3)",
    )
    .bind(game_id)
    .bind(lo)
    .bind(hi)
    .execute(&mut *conn)
    .await?;
    sqlx::query(&format!(
        "INSERT INTO score_bests ({COLS}) \
         SELECT game_id, period, period_start, user_id, id, score, rank_score, created_at, rid \
         FROM ( \
           SELECT x.*, ROW_NUMBER() OVER ( \
                    PARTITION BY x.period, x.period_start, x.user_id \
                    ORDER BY x.rank_score, x.created_at, x.rid) AS rn \
           FROM ( \
             SELECT s.game_id, s.user_id, s.id, s.score, s.created_at, s.rowid AS rid, \
                    CASE WHEN g.score_order = 'asc' THEN s.score ELSE -s.score END \
                      AS rank_score, \
                    p.period, \
                    CASE p.period \
                      WHEN 'all' THEN '' \
                      WHEN 'day' THEN substr(s.created_at, 1, 10) || 'T00:00:00.000Z' \
                      ELSE date(s.created_at, 'weekday 0', '-6 days') || 'T00:00:00.000Z' \
                    END AS period_start \
             FROM scores s \
             JOIN games g ON g.id = s.game_id \
             CROSS JOIN (SELECT 'all' AS period UNION ALL SELECT 'day' UNION ALL SELECT 'week') p \
             WHERE s.game_id = ?1 AND s.user_id > ?2 AND (?3 IS NULL OR s.user_id <= ?3) \
           ) x \
         ) WHERE rn = 1"
    ))
    .bind(game_id)
    .bind(lo)
    .bind(hi)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Rebuild `game_id`'s `score_bests` in batches of `batch` users. Returns `true` when the game
/// is no longer stale (rebuilt, never stale, or deleted).
pub async fn rebuild_game(db: &SqlitePool, game_id: &str, batch: i64) -> AppResult<bool> {
    // A flip during the rebuild bumps the generation; start over (bounded, flips are rare).
    for _ in 0..8 {
        let generation: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM score_bests_stale WHERE game_id = ?")
                .bind(game_id)
                .fetch_optional(db)
                .await?;
        let Some(generation) = generation else {
            return Ok(true);
        };
        let mut lo = String::new();
        let restarted = loop {
            // Upper bound of the next batch (read outside the write transaction; users that
            // appear in between are covered by the range).
            let hi: Option<String> = sqlx::query_scalar(
                "SELECT MAX(user_id) FROM (SELECT DISTINCT user_id FROM scores \
                 WHERE game_id = ?1 AND user_id > ?2 ORDER BY user_id LIMIT ?3)",
            )
            .bind(game_id)
            .bind(&lo)
            .bind(batch.max(1))
            .fetch_one(db)
            .await?;
            let mut tx = db.begin().await?;
            rewrite_users(&mut tx, game_id, &lo, hi.as_deref()).await?;
            let current: Option<i64> =
                sqlx::query_scalar("SELECT generation FROM score_bests_stale WHERE game_id = ?")
                    .bind(game_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            match current {
                None => {
                    // Game deleted meanwhile (the mark cascades); nothing to keep.
                    tx.rollback().await?;
                    return Ok(true);
                }
                Some(g) if g != generation => {
                    tx.rollback().await?;
                    break true;
                }
                Some(_) => {}
            }
            match hi {
                Some(hi) => {
                    tx.commit().await?;
                    lo = hi;
                }
                None => {
                    // Last batch: everything above `lo` was rewritten; clear the mark.
                    sqlx::query(
                        "DELETE FROM score_bests_stale WHERE game_id = ? AND generation = ?",
                    )
                    .bind(game_id)
                    .bind(generation)
                    .execute(&mut *tx)
                    .await?;
                    tx.commit().await?;
                    break false;
                }
            }
        };
        if !restarted {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Rebuild every stale game. Returns the number of games that are no longer stale.
pub async fn rebuild_stale(db: &SqlitePool, batch: i64) -> AppResult<usize> {
    let games: Vec<String> = sqlx::query_scalar("SELECT game_id FROM score_bests_stale")
        .fetch_all(db)
        .await?;
    let mut done = 0;
    for g in games {
        if rebuild_game(db, &g, batch).await? {
            done += 1;
        }
    }
    Ok(done)
}

/// Run [`rebuild_stale`] in the background (after a bundle replace commits, and at startup).
/// Runs are serialised by `AppState::bests_rebuild`; a run that waited finds the work done or
/// picks up newer marks. Failures are logged; the next run (or restart) retries.
pub fn spawn_rebuild(state: &AppState) -> tokio::task::JoinHandle<()> {
    let db = state.db.clone();
    let lock = state.bests_rebuild.clone();
    let runs = state.bests_runs.clone();
    tokio::spawn(async move {
        let _guard = lock.lock().await;
        match rebuild_stale(&db, REBUILD_BATCH_USERS).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(games = n, "score_bests rebuilt after an order change"),
            Err(e) => tracing::warn!(error = %e, "score_bests rebuild failed"),
        }
        runs.send_modify(|n| *n += 1);
    })
}
