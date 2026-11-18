//! Moderation: POST /api/reports, GET /api/admin/reports, POST /api/admin/reports/{id}/resolve.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AdminUser, AuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{Page, UserRef, now_rfc3339, user_ref_from_row};
use crate::ratelimit::Limit;
use crate::routes::collections::{load_collection, remove_collection};
use crate::routes::comments::remove_comment;
use crate::routes::games::{
    fetch_visible_game, limit_user, page_offset, parse_paging, remove_game,
};
use crate::routes::posts::remove_post;
use crate::routes::screenshots::{is_admin, remove_screenshot};
use crate::routes::users::clear_profile;
use crate::screenshots::{image_url, thumb_url};

pub const REPORT_DETAILS_MAX: usize = 1000;
pub const PREVIEW_MAX: usize = 140;
pub const REASONS: &[&str] = &["spam", "offensive", "broken", "copyright", "other"];
/// F008: the report target types. Since migration 0016 the database no longer has a CHECK on
/// `reports.target_type`; this list (enforced in [`create_report`]) is the only check, so a
/// later target type needs no table rebuild.
pub const TARGET_TYPES: &[&str] = &[
    "game",
    "comment",
    "screenshot",
    "collection",
    "user",
    "post",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_preview: String,
    /// F008: `None` for `"collection"`, (F028) `"user"` and (F030) `"post"` reports; a game id
    /// for every other type.
    pub target_game_id: Option<String>,
    pub reason: String,
    pub details: String,
    pub reporter: UserRef,
    pub status: String,
    pub resolution: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
    /// F005: the screenshot's `thumbUrl` while it exists; null for other target types.
    pub target_image_url: Option<String>,
    /// L7: the screenshot's full-size `imageUrl` while it exists; null for other target types.
    pub target_image_full_url: Option<String>,
}

const REPORT_SELECT: &str = "SELECT r.id, r.target_type, r.target_id, r.target_preview, \
     r.target_game_id, r.reason, r.details, r.status, r.resolution, r.created_at, \
     r.resolved_at, u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
     u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version, s.id AS s_id, \
     s.ext AS s_ext \
     FROM reports r JOIN users u ON u.id = r.reporter_id \
     LEFT JOIN screenshots s ON r.target_type = 'screenshot' AND s.id = r.target_id";

fn report_from_row(row: &SqliteRow) -> Result<Report, sqlx::Error> {
    let shot: Option<String> = row.try_get("s_id")?;
    let ext: Option<String> = row.try_get("s_ext")?;
    Ok(Report {
        id: row.try_get("id")?,
        target_type: row.try_get("target_type")?,
        target_id: row.try_get("target_id")?,
        target_preview: row.try_get("target_preview")?,
        target_game_id: row.try_get("target_game_id")?,
        reason: row.try_get("reason")?,
        details: row.try_get("details")?,
        reporter: user_ref_from_row(row, "u_")?,
        status: row.try_get("status")?,
        resolution: row.try_get("resolution")?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
        target_image_url: shot.as_deref().map(thumb_url),
        target_image_full_url: shot
            .as_deref()
            .zip(ext.as_deref())
            .map(|(id, ext)| image_url(id, ext)),
    })
}

async fn load_report(state: &AppState, id: &str) -> AppResult<Report> {
    let row = sqlx::query(&format!("{REPORT_SELECT} WHERE r.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("Report"))?;
    Ok(report_from_row(&row)?)
}

fn unknown_target_type() -> AppError {
    AppError::validation(
        "targetType must be \"game\", \"comment\", \"screenshot\", \"collection\", \"user\" or \"post\"",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReportBody {
    pub target_type: String,
    pub target_id: String,
    pub reason: String,
    pub details: Option<String>,
}

pub async fn create_report(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<CreateReportBody>,
) -> AppResult<(StatusCode, Json<Report>)> {
    limit_user(&state, Limit::Report, &user.id)?;
    if !REASONS.contains(&body.reason.as_str()) {
        return Err(AppError::validation(format!(
            "reason must be one of: {}",
            REASONS.join(", ")
        )));
    }
    let details = body.details.as_deref().unwrap_or("").trim().to_string();
    if details.chars().count() > REPORT_DETAILS_MAX {
        return Err(AppError::validation(format!(
            "details must be at most {REPORT_DETAILS_MAX} characters"
        )));
    }
    if !TARGET_TYPES.contains(&body.target_type.as_str()) {
        return Err(unknown_target_type());
    }
    let (game_id, preview): (Option<String>, String) = match body.target_type.as_str() {
        "game" => {
            let g = fetch_visible_game(&state, &body.target_id, Some(&user.id)).await?;
            (Some(g.id), g.title)
        }
        "comment" => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT game_id, body FROM comments WHERE id = ?")
                    .bind(&body.target_id)
                    .fetch_optional(&state.db)
                    .await?;
            let (game_id, text) = row.ok_or_else(|| AppError::not_found("Comment"))?;
            // The comment's game must be visible to the reporter.
            fetch_visible_game(&state, &game_id, Some(&user.id))
                .await
                .map_err(|_| AppError::not_found("Comment"))?;
            (Some(game_id), text.chars().take(PREVIEW_MAX).collect())
        }
        "screenshot" => {
            let row = sqlx::query(
                "SELECT s.game_id, s.caption, u.username, u.display_name FROM screenshots s \
                 JOIN users u ON u.id = s.author_id WHERE s.id = ?",
            )
            .bind(&body.target_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::not_found("Screenshot"))?;
            let game_id: String = row.try_get("game_id")?;
            let caption: String = row.try_get("caption")?;
            fetch_visible_game(&state, &game_id, Some(&user.id))
                .await
                .map_err(|_| AppError::not_found("Screenshot"))?;
            let preview = if caption.is_empty() {
                let display: String = row.try_get("display_name")?;
                let name = if display.trim().is_empty() {
                    row.try_get::<String, _>("username")?
                } else {
                    display
                };
                format!("Screenshot by {name}")
            } else {
                caption.chars().take(PREVIEW_MAX).collect()
            };
            (Some(game_id), preview)
        }
        // F008: the collection must be visible to the reporter (private → owner/admin only).
        "collection" => {
            let admin = is_admin(&state, Some(&user.id)).await?;
            let c = load_collection(&state, &body.target_id, Some(&user.id), admin).await?;
            (None, c.title.chars().take(PREVIEW_MAX).collect())
        }
        // F028: a profile; usernames never change, so the preview stays accurate.
        "user" => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT id, username FROM users WHERE id = ?")
                    .bind(&body.target_id)
                    .fetch_optional(&state.db)
                    .await?;
            let (id, username) = row.ok_or_else(|| AppError::not_found("User"))?;
            if id == user.id {
                return Err(AppError::validation("You can't report yourself"));
            }
            (None, format!("@{username}"))
        }
        // F030: posts are public; the preview is the body's first 140 code points.
        "post" => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT author_id, body FROM posts WHERE id = ?")
                    .bind(&body.target_id)
                    .fetch_optional(&state.db)
                    .await?;
            let (author_id, text) = row.ok_or_else(|| AppError::not_found("Post"))?;
            if author_id == user.id {
                return Err(AppError::validation("You can't report your own post"));
            }
            (None, text.chars().take(PREVIEW_MAX).collect())
        }
        _ => return Err(unknown_target_type()),
    };

    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? \
         AND status = 'open'",
    )
    .bind(&user.id)
    .bind(&body.target_type)
    .bind(&body.target_id)
    .fetch_optional(&state.db)
    .await?;
    if existing.is_some() {
        return Err(AppError::Conflict(
            "You already have an open report on this item".into(),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, \
         reason, details, reporter_id, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
    )
    .bind(&id)
    .bind(&body.target_type)
    .bind(&body.target_id)
    .bind(&game_id)
    .bind(&preview)
    .bind(&body.reason)
    .bind(&details)
    .bind(&user.id)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(load_report(&state, &id).await?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReportsQuery {
    pub status: Option<String>,
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn admin_list_reports(
    State(state): State<AppState>,
    _admin: AdminUser,
    ApiQuery(query): ApiQuery<AdminReportsQuery>,
) -> AppResult<Json<Page<Report>>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;
    let status = match query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(s @ ("open" | "resolved")) => Some(s.to_string()),
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "Unknown status '{other}' (expected open or resolved)"
            )));
        }
    };
    let filter = "(?1 IS NULL OR r.status = ?1)";
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM reports r WHERE {filter}"))
        .bind(&status)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&format!(
        "{REPORT_SELECT} WHERE {filter} ORDER BY r.created_at DESC, r.rowid DESC \
         LIMIT ?2 OFFSET ?3"
    ))
    .bind(&status)
    .bind(per_page)
    .bind(page_offset(page, per_page))
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .iter()
        .map(report_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

#[derive(Deserialize)]
pub struct ResolveBody {
    pub action: String,
}

/// Resolve a report: apply the action to its target, then resolve every open report on the
/// same target with the same resolution.
pub async fn admin_resolve_report(
    State(state): State<AppState>,
    _admin: AdminUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<ResolveBody>,
) -> AppResult<Json<Report>> {
    let report = load_report(&state, &id).await?;
    let action = body.action.as_str();
    // F028: the validity table in API § F028 (checked before the "already resolved" 409).
    match (action, report.target_type.as_str()) {
        ("dismiss" | "clearProfile", "user") => {}
        ("unpublish" | "delete", "user") => {
            return Err(AppError::validation(
                "action must be \"dismiss\" or \"clearProfile\" for user reports",
            ));
        }
        ("dismiss" | "delete", _) | ("unpublish", "game") => {}
        ("unpublish", _) => {
            return Err(AppError::validation(
                "unpublish is only valid for game reports",
            ));
        }
        ("clearProfile", _) => {
            return Err(AppError::validation(
                "clearProfile is only valid for user reports",
            ));
        }
        _ => {
            return Err(AppError::validation(
                "action must be \"dismiss\", \"unpublish\", \"delete\" or \"clearProfile\"",
            ));
        }
    }
    if report.status != "open" {
        return Err(AppError::Conflict("Report is already resolved".into()));
    }

    // Apply the action. A target that is already gone is not an error.
    match (action, report.target_type.as_str()) {
        ("unpublish", "game") => {
            sqlx::query("UPDATE games SET published = 0, updated_at = ? WHERE id = ?")
                .bind(now_rfc3339())
                .bind(&report.target_id)
                .execute(&state.db)
                .await?;
        }
        ("delete", "game") => remove_game(&state, &report.target_id).await?,
        ("delete", "screenshot") => remove_screenshot(&state, &report.target_id).await?,
        // F006: same effects as `DELETE /api/comments/{id}` (replies cascade, open reports on
        // every deleted comment are resolved).
        ("delete", "comment") => remove_comment(&state, &report.target_id).await?,
        // F008: same effects as `DELETE /api/collections/{id}` (items cascade, open reports
        // on it resolved); a collection that is already gone is a no-op.
        ("delete", "collection") => remove_collection(&state, &report.target_id).await?,
        // F028: reset the profile (name, bio, links, avatar, banner); content stays.
        ("clearProfile", "user") => clear_profile(&state, &report.target_id).await?,
        // F030: same effects as `DELETE /api/posts/{id}`; a post already gone is a no-op.
        ("delete", "post") => remove_post(&state, &report.target_id).await?,
        _ => {}
    }

    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = ?, resolved_at = ? \
         WHERE target_type = ? AND target_id = ? AND status = 'open'",
    )
    .bind(action)
    .bind(now_rfc3339())
    .bind(&report.target_type)
    .bind(&report.target_id)
    .execute(&state.db)
    .await?;
    Ok(Json(load_report(&state, &id).await?))
}
