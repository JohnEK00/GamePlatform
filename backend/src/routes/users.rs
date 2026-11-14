//! /api/users/*

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiMultipart, ApiPath, ApiQuery};
use crate::models::{
    GAME_SELECT, GameSummary, USER_COLUMNS, User, game_row_from_row, user_from_row,
};
use crate::routes::auth::load_user;
use crate::routes::games::parse_paging;
use crate::storage::validate_image;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub user: User,
    /// One page of the user's games, newest first (`?page=&perPage=`, default 24, max 100).
    pub games: Vec<GameSummary>,
    /// Number of the user's games visible to the viewer (all pages).
    pub games_total: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn get_user(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<ProfileQuery>,
) -> AppResult<Json<UserProfile>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;
    let row = sqlx::query(&format!(
        "SELECT {USER_COLUMNS} FROM users WHERE username_lower = ?"
    ))
    .bind(username.to_ascii_lowercase())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("User"))?;
    let user = user_from_row(&row)?;
    let is_me = viewer.id() == Some(user.user_ref.id.as_str());
    let filter = if is_me { "" } else { "AND g.published = 1" };
    let sql = format!(
        "{GAME_SELECT} WHERE g.owner_id = ? {filter} ORDER BY g.created_at DESC, g.id \
         LIMIT ? OFFSET ?"
    );
    let rows = sqlx::query(&sql)
        .bind(&user.user_ref.id)
        .bind(per_page)
        .bind((page - 1) * per_page)
        .fetch_all(&state.db)
        .await?;
    let games = rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| g.summary()))
        .collect::<Result<Vec<_>, _>>()?;
    let games_total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM games g WHERE g.owner_id = ? {filter}"
    ))
    .bind(&user.user_ref.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(UserProfile {
        user,
        games,
        games_total,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeBody {
    pub display_name: Option<String>,
    pub bio: Option<String>,
}

pub const DISPLAY_NAME_MAX: usize = 50;
pub const BIO_MAX: usize = 1000;

pub async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<UpdateMeBody>,
) -> AppResult<Json<User>> {
    if let Some(name) = body.display_name {
        let name = name.trim().to_string();
        let len = name.chars().count();
        if len == 0 || len > DISPLAY_NAME_MAX {
            return Err(AppError::validation(format!(
                "displayName must be 1-{DISPLAY_NAME_MAX} characters"
            )));
        }
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
            .bind(&name)
            .bind(&user.id)
            .execute(&state.db)
            .await?;
    }
    if let Some(bio) = body.bio {
        let bio = bio.trim().to_string();
        if bio.chars().count() > BIO_MAX {
            return Err(AppError::validation(format!(
                "bio must be at most {BIO_MAX} characters"
            )));
        }
        sqlx::query("UPDATE users SET bio = ? WHERE id = ?")
            .bind(&bio)
            .bind(&user.id)
            .execute(&state.db)
            .await?;
    }
    Ok(Json(load_user(&state, &user.id).await?))
}

pub async fn upload_avatar(
    State(state): State<AppState>,
    user: AuthUser,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Json<User>> {
    let mut avatar = None;
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("avatar") {
            avatar = Some(field.bytes().await?);
        }
    }
    let bytes = avatar.ok_or_else(|| AppError::validation("avatar file is required"))?;
    let ext = validate_image(&bytes, "avatar")?;
    let dir = state.storage.avatars_dir();
    state
        .storage
        .replace_image(&dir, &user.id, ext, &bytes)
        .await?;
    sqlx::query(
        "UPDATE users SET avatar_ext = ?, avatar_version = avatar_version + 1 WHERE id = ?",
    )
    .bind(ext)
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    Ok(Json(load_user(&state, &user.id).await?))
}
