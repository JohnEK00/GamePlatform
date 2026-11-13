//! Achievements: definitions come from the current bundle's game.json (synced on upload).

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiPath, ApiQuery};
use crate::models::{
    AchievementDef, GameAchievement, UserAchievement, achievement_icon_url, now_rfc3339,
};
use crate::routes::games::fetch_visible_game;

const USER_ACH_SELECT: &str = "SELECT ua.game_id, ua.ach_id, ua.unlocked_at, a.name, \
     a.description, a.icon, g.title AS game_title \
     FROM user_achievements ua \
     JOIN achievements a ON a.game_id = ua.game_id AND a.ach_id = ua.ach_id \
     JOIN games g ON g.id = ua.game_id";

fn user_achievement_from_row(row: &SqliteRow) -> Result<UserAchievement, sqlx::Error> {
    let game_id: String = row.try_get("game_id")?;
    let icon: Option<String> = row.try_get("icon")?;
    Ok(UserAchievement {
        def: AchievementDef {
            id: row.try_get("ach_id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            icon_url: achievement_icon_url(&game_id, icon.as_deref()),
        },
        game_title: row.try_get("game_title")?,
        unlocked_at: row.try_get("unlocked_at")?,
        game_id,
    })
}

/// GET /api/games/{id}/achievements (🔓): definitions in game.json order with unlock counts.
pub async fn list_game_achievements(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Vec<GameAchievement>>> {
    fetch_visible_game(&state, &id, viewer.id()).await?;
    let rows = sqlx::query(
        "SELECT a.ach_id, a.name, a.description, a.icon, \
           (SELECT COUNT(*) FROM user_achievements ua \
              WHERE ua.game_id = a.game_id AND ua.ach_id = a.ach_id) AS unlocked_by, \
           (SELECT ua.unlocked_at FROM user_achievements ua WHERE ua.game_id = a.game_id \
              AND ua.ach_id = a.ach_id AND ua.user_id = ?2) AS mine \
         FROM achievements a WHERE a.game_id = ?1 ORDER BY a.position",
    )
    .bind(&id)
    .bind(viewer.id())
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let icon: Option<String> = row.try_get("icon")?;
        out.push(GameAchievement {
            def: AchievementDef {
                id: row.try_get("ach_id")?,
                name: row.try_get("name")?,
                description: row.try_get("description")?,
                icon_url: achievement_icon_url(&id, icon.as_deref()),
            },
            unlocked_by: row.try_get("unlocked_by")?,
            unlocked_at: row.try_get("mine")?,
        });
    }
    Ok(Json(out))
}

#[derive(Serialize)]
pub struct UnlockResponse {
    pub achievement: UserAchievement,
    pub new: bool,
}

/// POST /api/games/{id}/achievements/{achievementId} (🔒, idempotent).
pub async fn unlock_achievement(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath((id, ach_id)): ApiPath<(String, String)>,
) -> AppResult<Json<UnlockResponse>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    let defined: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM achievements WHERE game_id = ? AND ach_id = ?")
            .bind(&id)
            .bind(&ach_id)
            .fetch_optional(&state.db)
            .await?;
    if defined.is_none() {
        return Err(AppError::not_found("Achievement"));
    }
    let res = sqlx::query(
        "INSERT INTO user_achievements (user_id, game_id, ach_id, unlocked_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT (user_id, game_id, ach_id) DO NOTHING",
    )
    .bind(&user.id)
    .bind(&id)
    .bind(&ach_id)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?;
    let row = sqlx::query(&format!(
        "{USER_ACH_SELECT} WHERE ua.user_id = ? AND ua.game_id = ? AND ua.ach_id = ?"
    ))
    .bind(&user.id)
    .bind(&id)
    .bind(&ach_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Achievement"))?;
    Ok(Json(UnlockResponse {
        achievement: user_achievement_from_row(&row)?,
        new: res.rows_affected() == 1,
    }))
}

#[derive(Deserialize)]
pub struct LimitQuery {
    pub limit: Option<String>,
}

/// GET /api/users/{username}/achievements: most recent first. Only unlocks on published games
/// (or on games the viewer owns) are listed.
pub async fn list_user_achievements(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<LimitQuery>,
) -> AppResult<Json<Vec<UserAchievement>>> {
    let limit = match query
        .limit
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => 50,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?,
    }
    .clamp(1, 100);
    let user_id: String = sqlx::query_scalar("SELECT id FROM users WHERE username_lower = ?")
        .bind(username.to_ascii_lowercase())
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("User"))?;
    let rows = sqlx::query(&format!(
        "{USER_ACH_SELECT} WHERE ua.user_id = ?1 AND (g.published = 1 OR g.owner_id = ?2) \
         ORDER BY ua.unlocked_at DESC, ua.rowid DESC LIMIT ?3"
    ))
    .bind(&user_id)
    .bind(viewer.id())
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.iter()
            .map(user_achievement_from_row)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}
