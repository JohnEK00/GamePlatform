//! Leaderboards: best score per user.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{Score, now_rfc3339, user_ref_from_row};
use crate::routes::games::fetch_visible_game;

#[derive(Deserialize)]
pub struct ScoresQuery {
    pub limit: Option<String>,
}

pub async fn list_scores(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ScoresQuery>,
) -> AppResult<Json<Vec<Score>>> {
    fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let limit = match query
        .limit
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => 10,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?,
    }
    .clamp(1, 100);

    // For each user keep their best score (earliest on ties).
    let rows = sqlx::query(
        "SELECT s.id, s.score, s.created_at, \
           u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
           u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
         FROM scores s JOIN users u ON u.id = s.user_id \
         WHERE s.game_id = ?1 AND s.id = ( \
           SELECT s2.id FROM scores s2 WHERE s2.game_id = ?1 AND s2.user_id = s.user_id \
           ORDER BY s2.score DESC, s2.created_at ASC, s2.rowid ASC LIMIT 1) \
         ORDER BY s.score DESC, s.created_at ASC LIMIT ?2",
    )
    .bind(&game_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    let mut prev: Option<i64> = None;
    let mut rank = 0;
    for (i, row) in rows.iter().enumerate() {
        let score: i64 = row.try_get("score")?;
        if prev != Some(score) {
            rank = i as i64 + 1;
            prev = Some(score);
        }
        out.push(Score {
            id: row.try_get("id")?,
            user: user_ref_from_row(row, "u_")?,
            score,
            created_at: row.try_get("created_at")?,
            rank,
        });
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ScoreBody {
    pub score: f64,
}

pub async fn submit_score(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiJson(body): ApiJson<ScoreBody>,
) -> AppResult<(StatusCode, Json<Score>)> {
    fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    crate::routes::games::limit_user(&state, crate::ratelimit::Limit::Score, &user.id)?;
    let s = body.score;
    // ±2^53: the range where f64 represents integers exactly.
    const LIMIT: f64 = 9_007_199_254_740_992.0;
    if !s.is_finite() || s.abs() > LIMIT {
        return Err(AppError::validation("score must be a finite integer"));
    }
    let score = s.round() as i64;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
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

    // Rank among other users' bests (competition ranking).
    let better: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (SELECT user_id, MAX(score) AS best FROM scores \
         WHERE game_id = ? AND user_id != ? GROUP BY user_id) WHERE best > ?",
    )
    .bind(&game_id)
    .bind(&user.id)
    .bind(score)
    .fetch_one(&state.db)
    .await?;

    let row = sqlx::query(
        "SELECT id AS u_id, username AS u_username, display_name AS u_display_name, \
         avatar_ext AS u_avatar_ext, avatar_version AS u_avatar_version FROM users WHERE id = ?",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(Score {
            id,
            user: user_ref_from_row(&row, "u_")?,
            score,
            created_at: now,
            rank: better + 1,
        }),
    ))
}
