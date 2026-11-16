//! F004 version history: GET /api/games/{id}/versions and PATCH …/versions/{version}.

use axum::Json;
use axum::extract::State;
use serde::Deserialize;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{GameVersion, Page};
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_owned_game, fetch_visible_game, limit_user, parse_paging};
use crate::versions::{parse_notes, parse_positive};

pub const VERSIONS_PER_PAGE: i64 = 20;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionsQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

/// GET /api/games/{id}/versions?page&perPage (🔓): highest version first.
pub async fn list_versions(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<VersionsQuery>,
) -> AppResult<Json<Page<GameVersion>>> {
    let game = fetch_visible_game(&state, &id, viewer.id()).await?;
    let (page, per_page) = parse_paging(
        query.page.as_deref(),
        query.per_page.as_deref(),
        VERSIONS_PER_PAGE,
    )?;
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT version, notes, created_at FROM game_versions WHERE game_id = ? \
         ORDER BY version DESC LIMIT ? OFFSET ?",
    )
    .bind(&id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_versions WHERE game_id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let items = rows
        .into_iter()
        .map(|(version, notes, created_at)| GameVersion {
            current: version == game.version,
            version,
            notes,
            created_at,
        })
        .collect();
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

/// PATCH /api/games/{id}/versions/{version} (🔒 owner) body `{ notes: string }`.
/// Only `notes` changes: no `updated_at`, `last_updated_at` or activity event.
pub async fn update_version_notes(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath((id, version)): ApiPath<(String, String)>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> AppResult<Json<GameVersion>> {
    let game = fetch_owned_game(&state, &id, &user.id).await?;
    limit_user(&state, Limit::VersionNotes, &user.id)?;
    let version = parse_positive(&version, "version")?;
    let raw = body
        .get("notes")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::validation("notes must be a string"))?;
    let notes = parse_notes(raw)?;

    let created_at: Option<String> = sqlx::query_scalar(
        "UPDATE game_versions SET notes = ? WHERE game_id = ? AND version = ? \
         RETURNING created_at",
    )
    .bind(&notes)
    .bind(&id)
    .bind(version)
    .fetch_optional(&state.db)
    .await?;
    let created_at = created_at.ok_or_else(|| AppError::not_found("Version"))?;
    Ok(Json(GameVersion {
        version,
        notes,
        created_at,
        current: version == game.version,
    }))
}
