//! F007: `/api/notifications` (list, unread count, mark read, settings).
//!
//! Order in every handler: auth (401) → `Limit::Notifications` (429) → parse/validate
//! (400/422) → work. Query strings and bodies are therefore parsed inside the handlers, after
//! the rate limit, instead of by extractors.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::Uri;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::notifications::{
    self as notif, Cursor, NotificationPage, NotificationSettings, SettingsPatch, UnreadCount,
};
use crate::ratelimit::Limit;
use crate::routes::games::limit_user;

pub const DEFAULT_LIMIT: i64 = 20;
pub const MAX_LIMIT: i64 = 50;
/// Most ids accepted by one mark-read request.
pub const MAX_IDS: usize = 100;

fn limit(state: &AppState, user: &AuthUser) -> AppResult<()> {
    limit_user(state, Limit::Notifications, &user.id)
}

#[derive(Deserialize)]
struct ListQuery {
    cursor: Option<String>,
    limit: Option<String>,
    unread: Option<String>,
}

/// `GET /api/notifications?cursor=&limit=20&unread=false`
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    uri: Uri,
) -> AppResult<Json<NotificationPage>> {
    limit(&state, &user)?;
    let Query(q) = Query::<ListQuery>::try_from_uri(&uri)?;
    let limit = match q.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(v) => v
            .trim()
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?
            .clamp(1, MAX_LIMIT),
    };
    let unread_only = match q.unread.as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        Some(_) => return Err(AppError::BadRequest("unread must be true or false".into())),
    };
    let cursor = match q.cursor.as_deref() {
        None => None,
        Some(c) => {
            Some(Cursor::decode(c).ok_or_else(|| AppError::BadRequest("Invalid cursor".into()))?)
        }
    };
    let (items, next_cursor) =
        notif::list_page(&state.db, &user.id, unread_only, cursor.as_ref(), limit).await?;
    let (unread, _) = notif::unread_count(&state.db, &user.id).await?;
    Ok(Json(NotificationPage {
        items,
        next_cursor,
        unread,
    }))
}

/// `GET /api/notifications/unread-count`
pub async fn unread_count(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<UnreadCount>> {
    limit(&state, &user)?;
    let (unread, latest_at) = notif::unread_count(&state.db, &user.id).await?;
    Ok(Json(UnreadCount {
        unread,
        latest_at,
        poll_after_secs: state.config.notification_poll_secs,
    }))
}

#[derive(serde::Serialize)]
pub struct MarkReadResponse {
    pub unread: i64,
}

fn parse_body(body: &Bytes) -> AppResult<serde_json::Map<String, Value>> {
    let v: Value = serde_json::from_slice(body)
        .map_err(|_| AppError::BadRequest("Request body must be valid JSON".into()))?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err(AppError::validation("Request body must be a JSON object")),
    }
}

/// `upTo`: RFC3339, normalised to the stored format (millis, `Z`).
fn parse_up_to(v: Option<&Value>) -> AppResult<String> {
    let s = v
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("upTo must be an RFC3339 timestamp"))?;
    let t = DateTime::parse_from_rfc3339(s.trim())
        .map_err(|_| AppError::validation("upTo must be an RFC3339 timestamp"))?;
    Ok(notif::stamp(t.with_timezone(&Utc)))
}

/// `ids`: absent or `null` = all; else 1–100 strings (422), each a positive integer (400).
fn parse_ids(v: Option<&Value>) -> AppResult<Option<Vec<i64>>> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(AppError::validation("ids must be an array of strings")),
    };
    if arr.is_empty() || arr.len() > MAX_IDS {
        return Err(AppError::validation(format!(
            "ids must have 1-{MAX_IDS} entries"
        )));
    }
    let strs: Vec<&str> = arr
        .iter()
        .map(Value::as_str)
        .collect::<Option<_>>()
        .ok_or_else(|| AppError::validation("ids must be an array of strings"))?;
    strs.into_iter()
        .map(|s| {
            notif::parse_positive_id(s)
                .ok_or_else(|| AppError::BadRequest("Each id must be a positive integer".into()))
        })
        .collect::<AppResult<Vec<_>>>()
        .map(Some)
}

/// `POST /api/notifications/read`
pub async fn mark_read(
    State(state): State<AppState>,
    user: AuthUser,
    body: Bytes,
) -> AppResult<Json<MarkReadResponse>> {
    limit(&state, &user)?;
    let body = parse_body(&body)?;
    let up_to = parse_up_to(body.get("upTo"))?;
    let ids = parse_ids(body.get("ids"))?;
    notif::mark_read(&state.db, &user.id, ids.as_deref(), &up_to, Utc::now()).await?;
    let (unread, _) = notif::unread_count(&state.db, &user.id).await?;
    Ok(Json(MarkReadResponse { unread }))
}

/// `GET /api/notifications/settings`
pub async fn get_settings(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<NotificationSettings>> {
    limit(&state, &user)?;
    Ok(Json(notif::load_settings(&state.db, &user.id).await?))
}

/// `PUT /api/notifications/settings` (partial; unknown fields ignored).
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    body: Bytes,
) -> AppResult<Json<NotificationSettings>> {
    limit(&state, &user)?;
    let body = parse_body(&body)?;
    let field = |name: &str| -> AppResult<Option<bool>> {
        match body.get(name) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(AppError::validation(format!("{name} must be a boolean"))),
        }
    };
    let patch = SettingsPatch {
        comments: field("comments")?,
        replies: field("replies")?,
        hearts: field("hearts")?,
        follows: field("follows")?,
        new_games: field("newGames")?,
    };
    if !patch.is_empty() {
        notif::update_settings(&state.db, &user.id, patch, Utc::now()).await?;
    }
    Ok(Json(notif::load_settings(&state.db, &user.id).await?))
}
