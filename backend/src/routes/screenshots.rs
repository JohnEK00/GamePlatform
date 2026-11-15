//! F005 screenshots: GET/POST /api/games/{id}/screenshots, DELETE /api/screenshots/{id}.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiMultipart, ApiPath, ApiQuery};
use crate::models::{Page, UserRef, now_rfc3339, user_ref_from_row};
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_visible_game, limit_user, parse_paging};
use crate::screenshots::{
    image_url, process_screenshot, remove_screenshot_files, thumb_url, write_screenshot_files,
};
use crate::storage::validate_image;

pub const CAPTION_MAX: usize = 140;
/// A `caption` multipart field larger than this (raw bytes) → 422.
pub const CAPTION_RAW_MAX: usize = 1024;
/// Stored screenshots per user per game.
pub const PER_USER_GAME_CAP: i64 = 20;
pub const PER_PAGE_DEFAULT: i64 = 12;
pub const PER_PAGE_MAX: i64 = 50;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub id: String,
    pub game_id: String,
    pub author: UserRef,
    pub caption: String,
    pub image_url: String,
    pub thumb_url: String,
    pub width: i64,
    pub height: i64,
    pub game_version: i64,
    pub created_at: String,
    pub can_delete: bool,
}

const SCREENSHOT_SELECT: &str = "SELECT s.id, s.game_id, s.author_id, s.caption, s.ext, \
     s.width, s.height, s.game_version, s.created_at, g.owner_id, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version \
     FROM screenshots s JOIN users u ON u.id = s.author_id JOIN games g ON g.id = s.game_id";

/// Who is looking: used for `canDelete`.
struct Viewer<'a> {
    id: Option<&'a str>,
    admin: bool,
}

fn screenshot_from_row(row: &SqliteRow, viewer: &Viewer<'_>) -> Result<Screenshot, sqlx::Error> {
    let id: String = row.try_get("id")?;
    let ext: String = row.try_get("ext")?;
    let author_id: String = row.try_get("author_id")?;
    let owner_id: String = row.try_get("owner_id")?;
    let can_delete = match viewer.id {
        None => false,
        Some(v) => viewer.admin || v == author_id || v == owner_id,
    };
    Ok(Screenshot {
        image_url: image_url(&id, &ext),
        thumb_url: thumb_url(&id),
        game_id: row.try_get("game_id")?,
        author: user_ref_from_row(row, "a_")?,
        caption: row.try_get("caption")?,
        width: row.try_get("width")?,
        height: row.try_get("height")?,
        game_version: row.try_get("game_version")?,
        created_at: row.try_get("created_at")?,
        can_delete,
        id,
    })
}

pub async fn is_admin(state: &AppState, user_id: Option<&str>) -> AppResult<bool> {
    let Some(uid) = user_id else {
        return Ok(false);
    };
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE id = ?")
        .bind(uid)
        .fetch_optional(&state.db)
        .await?;
    Ok(role.as_deref() == Some("admin"))
}

/// Caption rules: trimmed, ≤ 140 scalar values, no control or bidi-control characters.
pub fn validate_caption(raw: &str) -> AppResult<String> {
    let text = raw.trim();
    if text.chars().count() > CAPTION_MAX {
        return Err(AppError::validation(format!(
            "caption must be at most {CAPTION_MAX} characters"
        )));
    }
    let bidi = |c: char| matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
    if text.chars().any(|c| c.is_control() || bidi(c)) {
        return Err(AppError::validation(
            "caption must be a single line of plain text",
        ));
    }
    Ok(text.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn list_screenshots(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<Screenshot>>> {
    fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let (page, per_page) = parse_paging(
        query.page.as_deref(),
        query.per_page.as_deref(),
        PER_PAGE_DEFAULT,
    )?;
    let per_page = per_page.clamp(1, PER_PAGE_MAX);
    let v = Viewer {
        id: viewer.id(),
        admin: is_admin(&state, viewer.id()).await?,
    };
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM screenshots WHERE game_id = ?")
        .bind(&game_id)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&format!(
        "{SCREENSHOT_SELECT} WHERE s.game_id = ? ORDER BY s.created_at DESC, s.id \
         LIMIT ? OFFSET ?"
    ))
    .bind(&game_id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .iter()
        .map(|r| screenshot_from_row(r, &v))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

fn busy() -> Response {
    let mut res =
        AppError::ServiceUnavailable("The server is busy, try again in a few seconds".into())
            .into_response();
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(5u32));
    res
}

fn cap_error() -> AppError {
    AppError::validation(format!(
        "You can post at most {PER_USER_GAME_CAP} screenshots per game"
    ))
}

pub async fn create_screenshot(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Response> {
    // 2-3: visibility, then the rate limit (before the body is read).
    fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    limit_user(&state, Limit::Screenshot, &user.id)?;

    // 4: multipart.
    let mut image = None;
    let mut caption_raw: Vec<u8> = Vec::new();
    while let Some(mut field) = multipart.next_field().await? {
        match field.name() {
            Some("image") => image = Some(field.bytes().await?),
            Some("caption") => {
                caption_raw.clear();
                while let Some(chunk) = field.chunk().await? {
                    caption_raw.extend_from_slice(&chunk);
                    if caption_raw.len() > CAPTION_RAW_MAX {
                        return Err(AppError::validation("caption is too large"));
                    }
                }
            }
            _ => {}
        }
    }
    let bytes = image
        .filter(|b| !b.is_empty())
        .ok_or_else(|| AppError::validation("image file is required"))?;

    // 5-6: magic bytes / size, then the caption.
    validate_image(&bytes, "image")?;
    let caption_str = std::str::from_utf8(&caption_raw)
        .map_err(|_| AppError::validation("caption must be valid UTF-8"))?;
    let caption = validate_caption(caption_str)?;

    // 7: per-user per-game cap (re-checked by the guarded insert).
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM screenshots WHERE author_id = ? AND game_id = ?")
            .bind(&user.id)
            .bind(&game_id)
            .fetch_one(&state.db)
            .await?;
    if count >= PER_USER_GAME_CAP {
        return Err(cap_error());
    }

    // 8-9: a decode slot, then decode + re-encode off the async runtime. L5: when the server
    // is busy (503), the image can't be decoded (422) or a server-side step fails, the
    // screenshot token taken in step 3 is refunded.
    let refund = || {
        state
            .limiter
            .refund(Limit::Screenshot, &format!("user:{}", user.id))
    };
    let Ok(permit) = state.image_slots.clone().try_acquire_owned() else {
        refund();
        return Ok(busy());
    };
    let processed = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        process_screenshot(&bytes)
    })
    .await
    {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            refund();
            return Err(e);
        }
        Err(e) => {
            refund();
            return Err(e.into());
        }
    };

    // 10: files.
    let id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = write_screenshot_files(&state.storage, &id, &processed).await {
        refund();
        return Err(e.into());
    }

    // 11: guarded insert; the game version is read in the same statement.
    let inserted = sqlx::query(
        "INSERT INTO screenshots (id, game_id, author_id, caption, ext, width, height, bytes, \
         game_version, created_at) \
         SELECT ?, g.id, ?, ?, ?, ?, ?, ?, g.version, ? FROM games g WHERE g.id = ? \
         AND (SELECT COUNT(*) FROM screenshots WHERE author_id = ? AND game_id = g.id) < ?",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&caption)
    .bind(processed.ext)
    .bind(processed.width)
    .bind(processed.height)
    .bind(processed.full.len() as i64)
    .bind(now_rfc3339())
    .bind(&game_id)
    .bind(&user.id)
    .bind(PER_USER_GAME_CAP)
    .execute(&state.db)
    .await;
    let rows = match inserted {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            remove_screenshot_files(&state.storage, &id).await;
            refund();
            return Err(e.into());
        }
    };
    if rows == 0 {
        remove_screenshot_files(&state.storage, &id).await;
        // The game was deleted meanwhile → 404; otherwise the cap was reached.
        fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
        return Err(cap_error());
    }

    // 12.
    let row = sqlx::query(&format!("{SCREENSHOT_SELECT} WHERE s.id = ?"))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let v = Viewer {
        id: Some(&user.id),
        admin: false,
    };
    let shot = screenshot_from_row(&row, &v)?;
    Ok((StatusCode::CREATED, Json(shot)).into_response())
}

/// Delete a screenshot row and its files, and resolve its open reports with `delete`.
/// A screenshot that is already gone is a no-op.
pub async fn remove_screenshot(state: &AppState, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM screenshots WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    remove_screenshot_files(&state.storage, id).await;
    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ? \
         WHERE target_type = 'screenshot' AND target_id = ? AND status = 'open'",
    )
    .bind(now_rfc3339())
    .bind(id)
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn delete_screenshot(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    let row = sqlx::query(
        "SELECT s.author_id, g.owner_id FROM screenshots s JOIN games g ON g.id = s.game_id \
         WHERE s.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Screenshot"))?;
    let author: String = row.try_get("author_id")?;
    let owner: String = row.try_get("owner_id")?;
    if user.id != author && user.id != owner && !is_admin(&state, Some(&user.id)).await? {
        return Err(AppError::forbidden());
    }
    remove_screenshot(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
