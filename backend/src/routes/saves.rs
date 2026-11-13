//! Cloud saves: one JSON object per user per game (max 256KB serialized).

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath};
use crate::models::now_rfc3339;
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_visible_game, limit_user};

pub const SAVE_MAX_BYTES: usize = 256 * 1024;

pub async fn get_save(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Value>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT data, updated_at FROM saves WHERE user_id = ? AND game_id = ?")
            .bind(&user.id)
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(match row {
        Some((data, updated_at)) => {
            let data: Value = serde_json::from_str(&data)
                .map_err(|e| AppError::Internal(format!("stored save is not JSON: {e}")))?;
            json!({ "data": data, "updatedAt": updated_at })
        }
        None => json!({ "data": null, "updatedAt": null }),
    }))
}

pub async fn put_save(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<Value>,
) -> AppResult<Json<Value>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    limit_user(&state, Limit::Save, &user.id)?;
    let data = match body.get("data") {
        Some(Value::Object(m)) => m,
        _ => {
            return Err(AppError::validation(
                "data must be a plain JSON object (not an array, null or primitive)",
            ));
        }
    };
    let serialized =
        serde_json::to_string(data).map_err(|e| AppError::Internal(format!("json: {e}")))?;
    if serialized.len() > SAVE_MAX_BYTES {
        return Err(AppError::PayloadTooLarge(
            "Save data must be at most 256KB".into(),
        ));
    }
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO saves (user_id, game_id, data, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id, game_id) DO UPDATE SET data = excluded.data, \
         updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&id)
    .bind(&serialized)
    .bind(&now)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "updatedAt": now })))
}

pub async fn delete_save(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    sqlx::query("DELETE FROM saves WHERE user_id = ? AND game_id = ?")
        .bind(&user.id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
