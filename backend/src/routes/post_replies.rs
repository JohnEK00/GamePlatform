//! F031 post replies (docs/API.md § F031 additions, docs/ARCHITECTURE.md § F031 additions):
//! `GET`/`POST /api/posts/{id}/replies` and `DELETE /api/post-replies/{id}`.
//!
//! One flat thread per post, oldest first, at most [`POST_REPLY_CAP`] replies. Bodies follow
//! the F030 body rules ([`validate_post_body`]). A reply may answer another reply of the same
//! post, which only records the answered reply's author (`reply_to_user_id`). Creating a reply
//! notifies the post's author and the `replyTo` user (`postReply`, best effort, after commit).
//! The heart and lock handlers live in `posts.rs`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{Page, UserRef, now_rfc3339, user_ref_from_row};
use crate::notifications::{self as notif, Dedupe, Kind, NewNotification, post_group};
use crate::ratelimit::Limit;
use crate::routes::games::{limit_user, page_offset, parse_paging};
use crate::routes::posts::{post_meta, validate_post_body};
use crate::routes::screenshots::is_admin;

/// Replies per post.
pub const POST_REPLY_CAP: i64 = 200;
pub const POST_REPLIES_PER_PAGE_DEFAULT: i64 = 50;
pub const POST_REPLIES_PER_PAGE_MAX: i64 = 200;

const REPLIES_OFF: &str = "Replies are turned off for this post";
const REPLY: &str = "Reply";
const POST: &str = "Post";

/// `PostReply` (API § F031 "Types").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostReply {
    pub id: String,
    pub post_id: String,
    pub author: UserRef,
    /// The author of the answered reply; `None` when answering the post, when answering
    /// yourself, or when that user was deleted.
    pub reply_to: Option<UserRef>,
    pub body: String,
    pub created_at: String,
    /// The reply's author wrote the post.
    pub by_post_author: bool,
    /// The viewer is the reply's author, the post's author or an admin; false when anonymous.
    pub can_delete: bool,
    /// `/p/{postId}?reply={id}` (in-app route).
    pub path: String,
}

/// `CreatePostReplyRequest`. `null` and absent `replyToId` both mean "answering the post".
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePostReplyBody {
    pub body: String,
    #[serde(default)]
    pub reply_to_id: Option<String>,
}

/// Reply columns, the post's author, the reply's author (`a_`) and the `replyTo` user (`t_`).
/// Append `WHERE …`.
pub const REPLY_SELECT: &str = "SELECT r.id, r.post_id, r.author_id, r.body, r.created_at, \
     p.author_id AS post_author_id, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version, \
     t.id AS t_id, t.username AS t_username, t.display_name AS t_display_name, \
     t.avatar_ext AS t_avatar_ext, t.avatar_version AS t_avatar_version \
     FROM post_replies r \
     JOIN posts p ON p.id = r.post_id \
     JOIN users u ON u.id = r.author_id \
     LEFT JOIN users t ON t.id = r.reply_to_user_id";

/// The thread page (`?1` post id, `?2` limit, `?3` offset). A test asserts the plan walks
/// `idx_post_replies_post_created` without a temp B-tree sort.
pub fn post_replies_page_sql() -> String {
    format!("{REPLY_SELECT} WHERE r.post_id = ?1 ORDER BY r.created_at, r.rowid LIMIT ?2 OFFSET ?3")
}

/// F031 guarded insert (inside `BEGIN IMMEDIATE`): `?7` = the cap, `?8` = 1 when the caller is
/// the post's author or an admin (they may reply while the post is locked).
const GUARDED_INSERT_SQL: &str = "\
    INSERT INTO post_replies (id, post_id, author_id, reply_to_user_id, body, created_at) \
    SELECT ?1, ?2, ?3, ?4, ?5, ?6 \
    WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2) \
      AND (?8 = 1 OR (SELECT locked_at FROM posts WHERE id = ?2) IS NULL) \
      AND (SELECT COUNT(*) FROM post_replies WHERE post_id = ?2) < ?7";

/// Replies for `rows` (selected with [`REPLY_SELECT`]) as `viewer` sees them, in row order.
pub(crate) fn replies_from_rows(
    rows: &[SqliteRow],
    viewer: Option<&str>,
    admin: bool,
) -> AppResult<Vec<PostReply>> {
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let id: String = r.try_get("id")?;
        let post_id: String = r.try_get("post_id")?;
        let author_id: String = r.try_get("author_id")?;
        let post_author_id: String = r.try_get("post_author_id")?;
        let reply_to = match r.try_get::<Option<String>, _>("t_id")? {
            Some(_) => Some(user_ref_from_row(r, "t_")?),
            None => None,
        };
        let can_delete = match viewer {
            None => false,
            Some(v) => admin || v == author_id || v == post_author_id,
        };
        out.push(PostReply {
            path: format!("/p/{post_id}?reply={id}"),
            author: user_ref_from_row(r, "a_")?,
            reply_to,
            body: r.try_get("body")?,
            created_at: r.try_get("created_at")?,
            by_post_author: author_id == post_author_id,
            can_delete,
            post_id,
            id,
        });
    }
    Ok(out)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PostRepliesQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

/// `perPage` for the thread: default 50, clamped to 1–200; non-integer → 400.
fn parse_per_page(v: Option<&str>) -> AppResult<i64> {
    let per = match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => POST_REPLIES_PER_PAGE_DEFAULT,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("perPage must be an integer".into()))?,
    };
    Ok(per.clamp(1, POST_REPLIES_PER_PAGE_MAX))
}

/// `GET /api/posts/{id}/replies?page=&perPage=` (🔓, no rate limit): the thread, oldest first.
/// The post is looked up before paging is parsed; `total` is `posts.reply_count`.
pub async fn list_post_replies(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PostRepliesQuery>,
) -> AppResult<Json<Page<PostReply>>> {
    post_meta(&state, &id).await?;
    // `page` keeps the shared rules (default 1, clamped, 400 when not an integer); `perPage`
    // has this endpoint's wider clamp.
    let (page, _) = parse_paging(query.page.as_deref(), None, POST_REPLIES_PER_PAGE_DEFAULT)?;
    let per_page = parse_per_page(query.per_page.as_deref())?;
    let total: i64 = sqlx::query_scalar("SELECT reply_count FROM posts WHERE id = ?1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(POST))?;
    let rows = sqlx::query(&post_replies_page_sql())
        .bind(&id)
        .bind(per_page)
        .bind(page_offset(page, per_page))
        .fetch_all(&state.db)
        .await?;
    let admin = is_admin(&state, viewer.id()).await?;
    let items = replies_from_rows(&rows, viewer.id(), admin)?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

/// `POST /api/posts/{id}/replies` (🔒), in the API order: auth → JSON → post (404) →
/// `Limit::PostReply` (429) → body rules (422) → `replyToId` (404) → lock (422) → guarded
/// insert under the cap (422 / 404) → notify → 201.
pub async fn create_post_reply(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(post_id): ApiPath<String>,
    ApiJson(req): ApiJson<CreatePostReplyBody>,
) -> AppResult<(StatusCode, Json<PostReply>)> {
    let meta = post_meta(&state, &post_id).await?;
    limit_user(&state, Limit::PostReply, &user.id)?;
    let body = validate_post_body(&req.body)?;

    let reply_to_user: Option<String> = match req.reply_to_id.as_deref() {
        None => None,
        Some(rid) => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT post_id, author_id FROM post_replies WHERE id = ?")
                    .bind(rid)
                    .fetch_optional(&state.db)
                    .await?;
            match row {
                Some((pid, author)) if pid == post_id => (author != user.id).then_some(author),
                _ => return Err(AppError::not_found(REPLY)),
            }
        }
    };

    // Looked up even when the post is unlocked now: it may be locked before the guarded insert
    // re-checks, and an admin must still get through then (`?8`).
    let moderator = meta.author_id == user.id || is_admin(&state, Some(&user.id)).await?;
    if meta.locked && !moderator {
        return Err(AppError::validation(REPLIES_OFF));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let inserted = sqlx::query(GUARDED_INSERT_SQL)
        .bind(&id)
        .bind(&post_id)
        .bind(&user.id)
        .bind(&reply_to_user)
        .bind(&body)
        .bind(notif::stamp(now))
        .bind(POST_REPLY_CAP)
        .bind(i64::from(moderator))
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if inserted == 0 {
        tx.rollback().await?;
        let locked: Option<bool> =
            sqlx::query_scalar("SELECT locked_at IS NOT NULL FROM posts WHERE id = ?")
                .bind(&post_id)
                .fetch_optional(&state.db)
                .await?;
        return Err(match locked {
            None => AppError::not_found(POST),
            Some(true) if !moderator => AppError::validation(REPLIES_OFF),
            Some(_) => {
                AppError::validation(format!("This post has reached {POST_REPLY_CAP} replies"))
            }
        });
    }
    tx.commit().await?;

    // Best effort, after the commit: the post's author and the replyTo user, each once, never
    // the poster (`notify_pool` skips the actor).
    let mut recipients: Vec<String> = vec![meta.author_id.clone()];
    if let Some(t) = &reply_to_user
        && !recipients.contains(t)
    {
        recipients.push(t.clone());
    }
    for recipient in recipients {
        notif::notify_pool(
            &state.db,
            &NewNotification {
                recipient_id: recipient,
                kind: Kind::PostReply,
                group_key: post_group(&post_id),
                game_id: None,
                comment_id: None,
                actor_id: user.id.clone(),
                event_comment_id: None,
                event_screenshot_id: None,
                dedupe: Dedupe::None,
                thread_id: None,
                collection_id: None,
                post_id: Some(post_id.clone()),
                event_post_reply_id: Some(id.clone()),
                now,
            },
        )
        .await;
    }

    let row = sqlx::query(&format!("{REPLY_SELECT} WHERE r.id = ?"))
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(REPLY))?;
    // The caller wrote it, so `canDelete` is true without the admin lookup.
    let reply = replies_from_rows(std::slice::from_ref(&row), Some(&user.id), false)?
        .pop()
        .ok_or_else(|| AppError::not_found(REPLY))?;
    Ok((StatusCode::CREATED, Json(reply)))
}

/// Delete a reply (`DELETE /api/post-replies/{id}` and the report `delete` action), in one
/// transaction: open `postReply` reports on it are resolved with `delete`, then the row is
/// deleted (its notification events cascade; the `0014` trigger removes an emptied
/// notification; the counter trigger decrements `reply_count`). An unknown id is a no-op.
pub async fn remove_post_reply(state: &AppState, id: &str) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2 \
         WHERE target_type = 'postReply' AND target_id = ?1 AND status = 'open'",
    )
    .bind(id)
    .bind(now_rfc3339())
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM post_replies WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// `DELETE /api/post-replies/{id}` (🔒 reply author, post author or admin; no rate limit):
/// 404 → 403 → 204.
pub async fn delete_post_reply(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT r.author_id, p.author_id FROM post_replies r JOIN posts p ON p.id = r.post_id \
         WHERE r.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (reply_author, post_author) = row.ok_or_else(|| AppError::not_found(REPLY))?;
    if reply_author != user.id
        && post_author != user.id
        && !is_admin(&state, Some(&user.id)).await?
    {
        return Err(AppError::forbidden());
    }
    remove_post_reply(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
