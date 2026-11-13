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
use crate::routes::games::{fetch_visible_game, limit_user, parse_paging, remove_game};

pub const REPORT_DETAILS_MAX: usize = 1000;
pub const PREVIEW_MAX: usize = 140;
pub const REASONS: &[&str] = &["spam", "offensive", "broken", "copyright", "other"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_preview: String,
    pub target_game_id: String,
    pub reason: String,
    pub details: String,
    pub reporter: UserRef,
    pub status: String,
    pub resolution: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

const REPORT_SELECT: &str = "SELECT r.id, r.target_type, r.target_id, r.target_preview, \
     r.target_game_id, r.reason, r.details, r.status, r.resolution, r.created_at, \
     r.resolved_at, u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
     u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
     FROM reports r JOIN users u ON u.id = r.reporter_id";

fn report_from_row(row: &SqliteRow) -> Result<Report, sqlx::Error> {
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
    let (game_id, preview) = match body.target_type.as_str() {
        "game" => {
            let g = fetch_visible_game(&state, &body.target_id, Some(&user.id)).await?;
            (g.id, g.title)
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
            (game_id, text.chars().take(PREVIEW_MAX).collect())
        }
        _ => {
            return Err(AppError::validation(
                "targetType must be \"game\" or \"comment\"",
            ));
        }
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
    .bind((page - 1) * per_page)
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
    match (action, report.target_type.as_str()) {
        ("dismiss" | "delete", _) | ("unpublish", "game") => {}
        ("unpublish", _) => {
            return Err(AppError::validation(
                "unpublish is only valid for game reports",
            ));
        }
        _ => {
            return Err(AppError::validation(
                "action must be \"dismiss\", \"unpublish\" or \"delete\"",
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
        ("delete", "comment") => {
            sqlx::query("DELETE FROM comments WHERE id = ?")
                .bind(&report.target_id)
                .execute(&state.db)
                .await?;
        }
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
