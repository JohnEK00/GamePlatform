//! Leaderboards: best score per user, per period window (API.md v1 + § F001).

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::SqliteConnection;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{LeaderboardConfig, Score, user_ref_from_row};
use crate::ratelimit::{ClientIp, Limit, key_for};
use crate::routes::games::fetch_visible_game;

/// Upper bound for `format: "time"` scores: 24h in milliseconds.
pub const TIME_SCORE_MAX: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Day,
    Week,
    All,
}

impl Period {
    /// `None`/blank → `all`; anything other than `day|week|all` → 400.
    pub fn parse(v: Option<&str>) -> AppResult<Period> {
        match v.map(str::trim).unwrap_or("") {
            "" | "all" => Ok(Period::All),
            "day" => Ok(Period::Day),
            "week" => Ok(Period::Week),
            other => Err(AppError::BadRequest(format!(
                "Unknown period '{other}' (expected day, week or all)"
            ))),
        }
    }
}

fn midnight_rfc3339(d: NaiveDate) -> String {
    d.and_time(NaiveTime::MIN)
        .and_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `[start, end)` of the window containing `now`, as RFC3339 millis `Z` strings (the format of
/// stored `created_at`, so string comparison orders correctly). `None` for `all`.
/// `day` is the UTC day; `week` is the ISO week (Monday 00:00 UTC).
pub fn period_bounds(period: Period, now: DateTime<Utc>) -> Option<(String, String)> {
    let today = now.date_naive();
    let (start, days) = match period {
        Period::All => return None,
        Period::Day => (today, 1),
        Period::Week => (
            today - chrono::Duration::days(i64::from(today.weekday().num_days_from_monday())),
            7,
        ),
    };
    let end = start + chrono::Duration::days(days);
    Some((midnight_rfc3339(start), midnight_rfc3339(end)))
}

// ---------------------------------------------------------------------------
// Boards from `score_bests` (N2, migration 0008)
// ---------------------------------------------------------------------------

/// `score_bests` key of the `period` window containing `now`: (`period`, `period_start`).
/// `period_start` is `""` for `all`, else the window start from [`period_bounds`].
pub fn period_key(period: Period, now: DateTime<Utc>) -> (&'static str, String) {
    match period {
        Period::All => ("all", String::new()),
        Period::Day => (
            "day",
            period_bounds(period, now).map(|b| b.0).unwrap_or_default(),
        ),
        Period::Week => (
            "week",
            period_bounds(period, now).map(|b| b.0).unwrap_or_default(),
        ),
    }
}

/// `score_bests.rank_score` of a score: smaller is better.
pub fn rank_score(score: i64, ascending: bool) -> i64 {
    if ascending { score } else { -score }
}

pub struct Board {
    /// Best first, at most `limit` entries; `Score.rank` = competition rank in the window.
    pub entries: Vec<Score>,
    /// Distinct users with >= 1 score in the window.
    pub total_players: i64,
    /// `me`'s best in the window with its rank (when `me` is given and has a score there).
    pub me: Option<Score>,
}

const BEST_COLS: &str = "b.score_id, b.score, b.rank_score, b.created_at, \
     u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
     u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version";

fn score_from_best(row: &sqlx::sqlite::SqliteRow, rank: i64) -> Result<Score, sqlx::Error> {
    Ok(Score {
        id: row.try_get("score_id")?,
        user: user_ref_from_row(row, "u_")?,
        score: row.try_get("score")?,
        created_at: row.try_get("created_at")?,
        rank,
    })
}

/// Competition rank of `rank_score` in a window: 1 + players with a strictly better best.
async fn rank_in_window(
    conn: &mut SqliteConnection,
    game_id: &str,
    key: &(&'static str, String),
    rank_score: i64,
    exclude_user: Option<&str>,
) -> AppResult<i64> {
    let better: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM score_bests INDEXED BY idx_score_bests_rank \
         WHERE game_id = ?1 AND period = ?2 AND period_start = ?3 AND rank_score < ?4 \
           AND (?5 IS NULL OR user_id <> ?5)",
    )
    .bind(game_id)
    .bind(key.0)
    .bind(&key.1)
    .bind(rank_score)
    .bind(exclude_user)
    .fetch_one(&mut *conn)
    .await?;
    Ok(better + 1)
}

/// `user_id`'s best in the window with its competition rank.
async fn my_best(
    conn: &mut SqliteConnection,
    game_id: &str,
    key: &(&'static str, String),
    user_id: &str,
) -> AppResult<Option<Score>> {
    let row = sqlx::query(&format!(
        "SELECT {BEST_COLS} FROM score_bests b CROSS JOIN users u ON u.id = b.user_id \
         WHERE b.game_id = ?1 AND b.period = ?2 AND b.period_start = ?3 AND b.user_id = ?4"
    ))
    .bind(game_id)
    .bind(key.0)
    .bind(&key.1)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let rank = rank_in_window(conn, game_id, key, row.try_get("rank_score")?, None).await?;
    Ok(Some(score_from_best(&row, rank)?))
}

/// Each user's best score in the `period` window containing `now` (`MAX` for desc, `MIN` for
/// asc; ties → earlier `created_at`), ranked with competition ranking. Reads `score_bests`:
/// the entries are an index walk of `limit` rows, ranks and the total are index counts.
/// `limit` may be 0 (only `me` is wanted; the total is then not computed and is 0).
pub async fn window_board(
    conn: &mut SqliteConnection,
    game_id: &str,
    period: Period,
    now: DateTime<Utc>,
    limit: i64,
    me: Option<&str>,
) -> AppResult<Board> {
    let key = period_key(period, now);
    let mut board = Board {
        entries: Vec::new(),
        total_players: 0,
        me: None,
    };
    if limit > 0 {
        let rows = sqlx::query(&format!(
            "SELECT {BEST_COLS} FROM score_bests b INDEXED BY idx_score_bests_rank \
             CROSS JOIN users u ON u.id = b.user_id \
             WHERE b.game_id = ?1 AND b.period = ?2 AND b.period_start = ?3 \
             ORDER BY b.rank_score, b.created_at, b.score_rowid LIMIT ?4"
        ))
        .bind(game_id)
        .bind(key.0)
        .bind(&key.1)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
        // The page starts at position 1, so a row's competition rank is the position of the
        // first row with the same score.
        let mut prev: Option<(i64, i64)> = None; // (rank_score, rank)
        for (i, row) in rows.iter().enumerate() {
            let rs: i64 = row.try_get("rank_score")?;
            let rank = match prev {
                Some((p, r)) if p == rs => r,
                _ => i as i64 + 1,
            };
            prev = Some((rs, rank));
            board.entries.push(score_from_best(row, rank)?);
        }
        board.total_players = sqlx::query_scalar(
            "SELECT COUNT(*) FROM score_bests INDEXED BY idx_score_bests_rank \
             WHERE game_id = ?1 AND period = ?2 AND period_start = ?3",
        )
        .bind(game_id)
        .bind(key.0)
        .bind(&key.1)
        .fetch_one(&mut *conn)
        .await?;
    }
    if let Some(uid) = me {
        board.me = my_best(conn, game_id, &key, uid).await?;
    }
    Ok(board)
}

fn parse_limit(v: Option<&str>) -> AppResult<i64> {
    Ok(match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => 10,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?,
    }
    .clamp(1, 100))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ScoresQuery {
    pub limit: Option<String>,
    pub period: Option<String>,
}

/// GET /api/games/{id}/scores: `Leaderboard.entries` for the period (default `all`).
/// Rate limited like leaderboard reads (`Limit::ScoreList`, 120/min, its own bucket; N2).
pub async fn list_scores(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ip: ClientIp,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ScoresQuery>,
) -> AppResult<Json<Vec<Score>>> {
    state
        .limiter
        .check(Limit::ScoreList, &key_for(viewer.id(), &ip))?;
    fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let limit = parse_limit(query.limit.as_deref())?;
    let period = Period::parse(query.period.as_deref())?;
    let mut conn = state.db.acquire().await?;
    let board = window_board(&mut conn, &game_id, period, Utc::now(), limit, None).await?;
    Ok(Json(board.entries))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    pub period: Period,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub config: LeaderboardConfig,
    pub entries: Vec<Score>,
    pub total_players: i64,
    pub me: Option<Score>,
}

/// GET /api/games/{id}/leaderboard?period=&limit= (🔓, rate limited).
pub async fn get_leaderboard(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ip: ClientIp,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ScoresQuery>,
) -> AppResult<Json<Leaderboard>> {
    state
        .limiter
        .check(Limit::Leaderboard, &key_for(viewer.id(), &ip))?;
    let game = fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let limit = parse_limit(query.limit.as_deref())?;
    let period = Period::parse(query.period.as_deref())?;
    let now = Utc::now();
    let bounds = period_bounds(period, now);
    let mut conn = state.db.acquire().await?;
    let board = window_board(&mut conn, &game_id, period, now, limit, viewer.id()).await?;
    drop(conn);
    let (period_start, period_end) = bounds.unzip();
    Ok(Json(Leaderboard {
        period,
        period_start,
        period_end,
        config: game.leaderboard,
        entries: board.entries,
        total_players: board.total_players,
        me: board.me,
    }))
}

#[derive(Deserialize)]
pub struct ScoreBody {
    pub score: f64,
}

#[derive(Serialize)]
pub struct Ranks {
    pub day: i64,
    pub week: i64,
    pub all: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreSubmitResult {
    #[serde(flatten)]
    pub score: Score,
    pub personal_best: bool,
    pub ranks: Ranks,
}

/// Scores kept per (game, user) regardless of age: the best N (best first, ties → earlier).
pub const SCORES_KEPT_PER_USER: i64 = 20;
/// Scores younger than this are also kept when they are the user's best of their UTC day or
/// ISO week, so the `day` and `week` windows (both shorter than this) never lose a best.
pub const SCORE_RECENT_DAYS: i64 = 8;

/// Retention (R12), run after each insert for that (game, user). A score is deleted when it is
/// outside the user's best [`SCORES_KEPT_PER_USER`] AND (it is older than
/// [`SCORE_RECENT_DAYS`] OR it is neither the user's best of its UTC day nor of its ISO week).
/// The user's all-time best (rank 1) and current day/week bests therefore always survive, so
/// every leaderboard window shows the same result as without pruning. "Best" uses the same
/// order as [`window_board`]: score (by the game's order), then earlier `created_at`, rowid.
/// Per user per game this keeps at most 20 + ~10 rows (8 recent days + 2 ISO weeks).
pub async fn prune_scores(
    db: &mut SqliteConnection,
    game_id: &str,
    user_id: &str,
    ascending: bool,
    now: DateTime<Utc>,
) -> AppResult<u64> {
    let dir = if ascending { "ASC" } else { "DESC" };
    let order = format!("ORDER BY score {dir}, created_at ASC, rowid ASC");
    let cutoff = (now - chrono::Duration::days(SCORE_RECENT_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let sql = format!(
        "DELETE FROM scores WHERE rowid IN ( \
           SELECT rid FROM ( \
             SELECT rowid AS rid, created_at, \
               ROW_NUMBER() OVER ({order}) AS r_all, \
               ROW_NUMBER() OVER (PARTITION BY substr(created_at, 1, 10) {order}) AS r_day, \
               ROW_NUMBER() OVER (PARTITION BY date(created_at, 'weekday 0', '-6 days') \
                 {order}) AS r_week \
             FROM scores WHERE game_id = ?1 AND user_id = ?2 \
           ) WHERE r_all > ?3 AND (created_at < ?4 OR (r_day > 1 AND r_week > 1)) \
         )"
    );
    let r = sqlx::query(&sql)
        .bind(game_id)
        .bind(user_id)
        .bind(SCORES_KEPT_PER_USER)
        .bind(cutoff)
        .execute(&mut *db)
        .await?;
    Ok(r.rows_affected())
}

/// POST /api/games/{id}/scores. The insert, the `score_bests` upkeep (triggers), pruning and
/// the rank reads run in one write-first transaction, so the ranks reflect exactly this write.
pub async fn submit_score(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiJson(body): ApiJson<ScoreBody>,
) -> AppResult<(StatusCode, Json<ScoreSubmitResult>)> {
    let game = fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    crate::routes::games::limit_user(&state, Limit::Score, &user.id)?;
    let s = body.score;
    // ±2^53: the range where f64 represents integers exactly.
    const LIMIT: f64 = 9_007_199_254_740_992.0;
    if !s.is_finite() || s.abs() > LIMIT {
        return Err(AppError::validation("score must be a finite integer"));
    }
    let score = s.round() as i64;
    if game.leaderboard.format == "time" && !(0..=TIME_SCORE_MAX).contains(&score) {
        return Err(AppError::validation(format!(
            "score must be between 0 and {TIME_SCORE_MAX} (milliseconds) for time leaderboards"
        )));
    }
    let asc = game.leaderboard.ascending();
    let agg = if asc { "MIN" } else { "MAX" };

    let id = uuid::Uuid::new_v4().to_string();
    let now_dt = Utc::now();
    let now = now_dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut tx = state.db.begin().await?;
    // Write first: the transaction holds the write lock from here on.
    sqlx::query(
        "INSERT INTO scores (id, game_id, user_id, score, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&game_id)
    .bind(&user.id)
    .bind(score)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    // Previous all-time best of this user (the other retained scores always include it).
    let prev: Option<i64> = sqlx::query_scalar(&format!(
        "SELECT {agg}(score) FROM scores WHERE game_id = ? AND user_id = ? AND id <> ?"
    ))
    .bind(&game_id)
    .bind(&user.id)
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    let personal_best = prev.is_none_or(|p| if asc { score < p } else { score > p });

    prune_scores(&mut tx, &game_id, &user.id, asc, now_dt).await?;

    // v1 `rank`: this score's rank among other users' all-time bests (competition ranking).
    let all_key = period_key(Period::All, now_dt);
    let rank = rank_in_window(
        &mut tx,
        &game_id,
        &all_key,
        rank_score(score, asc),
        Some(&user.id),
    )
    .await?;

    // Rank of the user's best in each window, after this submit.
    let mut r = [0i64; 3];
    for (slot, period) in r.iter_mut().zip([Period::Day, Period::Week, Period::All]) {
        *slot = my_best(&mut tx, &game_id, &period_key(period, now_dt), &user.id)
            .await?
            .map(|m| m.rank)
            .ok_or_else(|| AppError::Internal("submitted score missing from its window".into()))?;
    }
    let ranks = Ranks {
        day: r[0],
        week: r[1],
        all: r[2],
    };

    let row = sqlx::query(
        "SELECT id AS u_id, username AS u_username, display_name AS u_display_name, \
         avatar_ext AS u_avatar_ext, avatar_version AS u_avatar_version FROM users WHERE id = ?",
    )
    .bind(&user.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    // F002 feed event (best effort, after the commit): PBs on published games, never for the
    // owner.
    if personal_best
        && game.published
        && game.owner_id != user.id
        && let Some(mut conn) = crate::activity::acquire(&state.db).await
    {
        crate::activity::record_personal_best(&mut conn, &user.id, &game_id, score, prev.is_none())
            .await;
    }

    Ok((
        StatusCode::CREATED,
        Json(ScoreSubmitResult {
            score: Score {
                id,
                user: user_ref_from_row(&row, "u_")?,
                score,
                created_at: now,
                rank,
            },
            personal_best,
            ranks,
        }),
    ))
}
