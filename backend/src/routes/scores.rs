//! Leaderboards: best score per user, per period window (API.md v1 + § F001).

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::SqlitePool;

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
// Shared "best per user in [start, end)" query
// ---------------------------------------------------------------------------

pub struct Board {
    /// Best first, at most `limit` entries; `Score.rank` = competition rank in the window.
    pub entries: Vec<Score>,
    /// Distinct users with >= 1 score in the window.
    pub total_players: i64,
    /// `me`'s best in the window with its rank (when `me` is given and has a score there).
    pub me: Option<Score>,
}

/// Each user's best score in the window (`MAX` for desc, `MIN` for asc; ties → earlier
/// `created_at`), ranked with competition ranking. `limit` may be 0 (only `me` is wanted).
pub async fn window_board(
    db: &SqlitePool,
    game_id: &str,
    ascending: bool,
    bounds: Option<&(String, String)>,
    limit: i64,
    me: Option<&str>,
) -> AppResult<Board> {
    // `dir` is one of two static strings, never user input.
    let dir = if ascending { "ASC" } else { "DESC" };
    let window = if bounds.is_some() {
        "AND s.created_at >= ?4 AND s.created_at < ?5"
    } else {
        ""
    };
    let sql = format!(
        "WITH w AS ( \
           SELECT s.id, s.user_id, s.score, s.created_at, s.rowid AS rid, \
             ROW_NUMBER() OVER (PARTITION BY s.user_id \
               ORDER BY s.score {dir}, s.created_at ASC, s.rowid ASC) AS rn \
           FROM scores s WHERE s.game_id = ?1 {window} \
         ), ranked AS ( \
           SELECT id, user_id, score, created_at, \
             RANK() OVER (ORDER BY score {dir}) AS rnk, \
             ROW_NUMBER() OVER (ORDER BY score {dir}, created_at ASC, rid ASC) AS pos, \
             COUNT(*) OVER () AS total \
           FROM w WHERE rn = 1 \
         ) \
         SELECT r.id, r.user_id, r.score, r.created_at, r.rnk, r.pos, r.total, \
           u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
           u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
         FROM ranked r JOIN users u ON u.id = r.user_id \
         WHERE r.pos <= ?2 OR r.user_id = ?3 \
         ORDER BY r.pos"
    );
    let mut q = sqlx::query(&sql).bind(game_id).bind(limit).bind(me);
    if let Some((start, end)) = bounds {
        q = q.bind(start).bind(end);
    }
    let rows = q.fetch_all(db).await?;

    let mut board = Board {
        entries: Vec::with_capacity(rows.len()),
        total_players: 0,
        me: None,
    };
    for row in &rows {
        board.total_players = row.try_get("total")?;
        let user_id: String = row.try_get("user_id")?;
        let pos: i64 = row.try_get("pos")?;
        let make = || -> Result<Score, sqlx::Error> {
            Ok(Score {
                id: row.try_get("id")?,
                user: user_ref_from_row(row, "u_")?,
                score: row.try_get("score")?,
                created_at: row.try_get("created_at")?,
                rank: row.try_get("rnk")?,
            })
        };
        if me == Some(user_id.as_str()) {
            board.me = Some(make()?);
        }
        if pos <= limit {
            board.entries.push(make()?);
        }
    }
    Ok(board)
}

/// Rank of `user_id`'s best score in the `period` window containing `now`.
async fn window_rank(
    db: &SqlitePool,
    game_id: &str,
    ascending: bool,
    period: Period,
    now: DateTime<Utc>,
    user_id: &str,
) -> AppResult<i64> {
    let bounds = period_bounds(period, now);
    let board = window_board(db, game_id, ascending, bounds.as_ref(), 0, Some(user_id)).await?;
    board
        .me
        .map(|m| m.rank)
        .ok_or_else(|| AppError::Internal("submitted score missing from its window".into()))
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
pub async fn list_scores(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ScoresQuery>,
) -> AppResult<Json<Vec<Score>>> {
    let game = fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let limit = parse_limit(query.limit.as_deref())?;
    let period = Period::parse(query.period.as_deref())?;
    let bounds = period_bounds(period, Utc::now());
    let board = window_board(
        &state.db,
        &game_id,
        game.leaderboard.ascending(),
        bounds.as_ref(),
        limit,
        None,
    )
    .await?;
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
    let bounds = period_bounds(period, Utc::now());
    let board = window_board(
        &state.db,
        &game_id,
        game.leaderboard.ascending(),
        bounds.as_ref(),
        limit,
        viewer.id(),
    )
    .await?;
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
    let (agg, better_than) = if asc { ("MIN", "<") } else { ("MAX", ">") };

    // Previous all-time best of this user (before inserting).
    let prev: Option<i64> = sqlx::query_scalar(&format!(
        "SELECT {agg}(score) FROM scores WHERE game_id = ? AND user_id = ?"
    ))
    .bind(&game_id)
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    let personal_best = prev.is_none_or(|p| if asc { score < p } else { score > p });

    let id = uuid::Uuid::new_v4().to_string();
    let now_dt = Utc::now();
    let now = now_dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query(
        "INSERT INTO scores (id, game_id, user_id, score, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&game_id)
    .bind(&user.id)
    .bind(score)
    .bind(&now)
    .execute(&state.db)
    .await?;

    // v1 `rank`: this score's rank among other users' all-time bests (competition ranking).
    let better: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM (SELECT user_id, {agg}(score) AS best FROM scores \
         WHERE game_id = ? AND user_id != ? GROUP BY user_id) WHERE best {better_than} ?"
    ))
    .bind(&game_id)
    .bind(&user.id)
    .bind(score)
    .fetch_one(&state.db)
    .await?;

    // Rank of the user's best in each window, after this submit.
    let rank_in = |period| window_rank(&state.db, &game_id, asc, period, now_dt, &user.id);
    let ranks = Ranks {
        day: rank_in(Period::Day).await?,
        week: rank_in(Period::Week).await?,
        all: rank_in(Period::All).await?,
    };

    let row = sqlx::query(
        "SELECT id AS u_id, username AS u_username, display_name AS u_display_name, \
         avatar_ext AS u_avatar_ext, avatar_version AS u_avatar_version FROM users WHERE id = ?",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(ScoreSubmitResult {
            score: Score {
                id,
                user: user_ref_from_row(&row, "u_")?,
                score,
                created_at: now,
                rank: better + 1,
            },
            personal_best,
            ranks,
        }),
    ))
}
