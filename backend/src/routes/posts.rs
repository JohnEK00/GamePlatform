//! F030 user posts (docs/API.md § F030 additions, docs/ARCHITECTURE.md § F030 additions):
//! `POST /api/posts`, `GET`/`DELETE /api/posts/{id}` and `GET /api/users/{username}/posts`.
//!
//! Posts are public plain text (1–500 code points, at most 12 lines) with an optional
//! attachment of one published game or one public collection. Creating a post writes a
//! `postCreated` activity event in the same transaction; deleting it cascades the event. The
//! attachment is resolved for each viewer at read time ([`posts_for`]).
//!
//! F031 (docs/API.md § F031 additions): every `Post` carries `hearts`, `myHeart`, `replyCount`
//! and `locked`; this module also has the heart (`PUT`/`DELETE /api/posts/{id}/heart`) and
//! lock (`PUT`/`DELETE /api/posts/{id}/lock`) handlers. Replies live in `post_replies.rs`.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::activity;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{
    CollectionSummary, GAME_SELECT, GameSummary, Page, UserRef, game_row_from_row, now_rfc3339,
    user_ref_from_row,
};
use crate::notifications::{self as notif, Dedupe, Kind, NewNotification, post_group};
use crate::ratelimit::Limit;
use crate::routes::collections::{
    COLLECTION_SELECT, collections_from_rows, load_collection, summaries_for,
};
use crate::routes::games::{fetch_visible_game, limit_user, page_offset, parse_paging};
use crate::routes::screenshots::is_admin;
use crate::routes::users::is_forbidden_label_char;

pub const POST_BODY_MAX: usize = 500;
pub const POST_LINES_MAX: usize = 12;
pub const POSTS_PER_DAY_MAX: i64 = 25;
pub const POSTS_PER_PAGE_DEFAULT: i64 = 20;
pub const POSTS_PER_PAGE_MAX: i64 = 50;

const NOT_FOUND: &str = "Post";

// ---------------------------------------------------------------------------
// Body rules
// ---------------------------------------------------------------------------

/// API § F030 "Body rules", in order: `\r\n`/`\r` → `\n` and trim; 1–500 code points; at most
/// 12 lines; no character from the shared forbidden set other than `\n` (which includes
/// U+2028/U+2029, so they can't bypass the line cap). Returns the text to store.
pub fn validate_post_body(raw: &str) -> AppResult<String> {
    let normalised = raw.replace("\r\n", "\n").replace('\r', "\n");
    let text = normalised.trim();
    let n = text.chars().count();
    if n == 0 || n > POST_BODY_MAX {
        return Err(AppError::validation("body must be 1–500 characters"));
    }
    if text.matches('\n').count() > POST_LINES_MAX - 1 {
        return Err(AppError::validation("body must be at most 12 lines"));
    }
    if text
        .chars()
        .any(|c| c != '\n' && is_forbidden_label_char(c))
    {
        return Err(AppError::validation("body must be plain text"));
    }
    Ok(text.to_string())
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/// `PostAttachment`: for type `"game"` only `game` may be set, for `"collection"` only
/// `collection`; a target the viewer can't see (or that was deleted) is `None`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAttachment {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub game: Option<GameSummary>,
    pub collection: Option<CollectionSummary>,
}

/// `Post` (API § F030 "Types").
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub author: UserRef,
    pub body: String,
    pub attachment: Option<PostAttachment>,
    pub created_at: String,
    /// The viewer is the author or an admin; false when anonymous.
    pub can_delete: bool,
    /// `/p/{id}` (in-app route).
    pub path: String,
    /// F031: distinct users who hearted the post (>= 0).
    pub hearts: i64,
    /// F031: the viewer hearted it; false when anonymous.
    pub my_heart: bool,
    /// F031: replies on the post (0–200).
    pub reply_count: i64,
    /// F031: replies turned off by the author or an admin (only they can still reply).
    pub locked: bool,
}

/// `PostHeartResponse` (API § F031).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostHeartResponse {
    pub hearted: bool,
    pub hearts: i64,
}

/// `CreatePostRequest`. `null` and absent attachment ids both mean "none".
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePostBody {
    pub body: String,
    #[serde(default)]
    pub game_id: Option<String>,
    #[serde(default)]
    pub collection_id: Option<String>,
}

/// Post columns + author (`a_` prefix). Append `WHERE …` (always a filter on `p`).
///
/// `CROSS JOIN` pins `posts` as the outer loop (SQLite never reorders it). With the F031
/// columns the planner otherwise may scan `users` first and sort the profile page in a temp
/// B-tree instead of walking `idx_posts_author_created`.
pub const POST_SELECT: &str = "SELECT p.id, p.author_id, p.body, p.attachment_type, p.game_id, \
     p.collection_id, p.created_at, p.hearts, p.reply_count, p.locked_at, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version \
     FROM posts p CROSS JOIN users u ON u.id = p.author_id";

/// F030 profile list page (`?1` author id, `?2` limit, `?3` offset). A test asserts the plan
/// walks `idx_posts_author_created` without a temp B-tree sort.
pub fn user_posts_page_sql() -> String {
    format!(
        "{POST_SELECT} WHERE p.author_id = ?1 ORDER BY p.created_at DESC, p.id LIMIT ?2 OFFSET ?3"
    )
}

/// F030 guarded insert: the post is written only while the author has fewer than
/// [`POSTS_PER_DAY_MAX`] posts created after `?8` (now − 24 h).
const GUARDED_INSERT_SQL: &str = "\
    INSERT INTO posts (id, author_id, body, attachment_type, game_id, collection_id, created_at) \
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 \
    WHERE (SELECT COUNT(*) FROM posts WHERE author_id = ?2 AND created_at > ?8) < ?9";

fn json_list(v: &[String]) -> AppResult<String> {
    serde_json::to_string(v).map_err(|e| AppError::Internal(format!("json: {e}")))
}

fn push_unique(list: &mut Vec<String>, v: Option<String>) {
    if let Some(v) = v
        && !list.contains(&v)
    {
        list.push(v);
    }
}

/// Posts for `rows` (selected with [`POST_SELECT`]) as `viewer` sees them, in row order. A
/// fixed number of queries per call (ARCHITECTURE § F030 "Read assembly"): `is_admin` once,
/// one game query, one collection query plus [`summaries_for`], and (F031) one `myHeart`
/// query when the viewer is signed in.
pub(crate) async fn posts_for(
    state: &AppState,
    rows: &[SqliteRow],
    viewer: Option<&str>,
) -> AppResult<Vec<Post>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let admin = is_admin(state, viewer).await?;

    let mut game_ids: Vec<String> = Vec::new();
    let mut collection_ids: Vec<String> = Vec::new();
    for r in rows {
        push_unique(&mut game_ids, r.try_get("game_id")?);
        push_unique(&mut collection_ids, r.try_get("collection_id")?);
    }

    let mut games: HashMap<String, GameSummary> = HashMap::new();
    if !game_ids.is_empty() {
        let game_rows = sqlx::query(&format!(
            "{GAME_SELECT} WHERE g.id IN (SELECT value FROM json_each(?))"
        ))
        .bind(json_list(&game_ids)?)
        .fetch_all(&state.db)
        .await?;
        for gr in &game_rows {
            let g = game_row_from_row(gr)?;
            if g.visible_to(viewer) {
                games.insert(g.id.clone(), g.summary());
            }
        }
    }

    let mut collections: HashMap<String, CollectionSummary> = HashMap::new();
    if !collection_ids.is_empty() {
        let crow = sqlx::query(&format!(
            "{COLLECTION_SELECT} WHERE c.id IN (SELECT value FROM json_each(?))"
        ))
        .bind(json_list(&collection_ids)?)
        .fetch_all(&state.db)
        .await?;
        let visible: Vec<_> = collections_from_rows(&crow)?
            .into_iter()
            .filter(|c| c.visible_to(viewer, admin))
            .collect();
        for s in summaries_for(state, &visible, viewer).await? {
            collections.insert(s.id.clone(), s);
        }
    }

    // F031: which of these posts the viewer hearted.
    let mut hearted: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(v) = viewer {
        let ids: Vec<String> = rows
            .iter()
            .map(|r| r.try_get::<String, _>("id"))
            .collect::<Result<_, _>>()?;
        hearted = sqlx::query_scalar::<_, String>(
            "SELECT post_id FROM post_hearts WHERE user_id = ?1 \
             AND post_id IN (SELECT value FROM json_each(?2))",
        )
        .bind(v)
        .bind(json_list(&ids)?)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .collect();
    }

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let id: String = r.try_get("id")?;
        let author_id: String = r.try_get("author_id")?;
        let kind: Option<String> = r.try_get("attachment_type")?;
        let attachment = match kind.as_deref() {
            None => None,
            Some("game") => Some(PostAttachment {
                kind: "game",
                game: r
                    .try_get::<Option<String>, _>("game_id")?
                    .and_then(|gid| games.get(&gid).cloned()),
                collection: None,
            }),
            Some("collection") => Some(PostAttachment {
                kind: "collection",
                game: None,
                collection: r
                    .try_get::<Option<String>, _>("collection_id")?
                    .and_then(|cid| collections.get(&cid).cloned()),
            }),
            Some(other) => {
                tracing::warn!(post_id = %id, attachment_type = other, "unknown post attachment type");
                None
            }
        };
        let can_delete = match viewer {
            None => false,
            Some(v) => admin || v == author_id,
        };
        out.push(Post {
            path: format!("/p/{id}"),
            author: user_ref_from_row(r, "a_")?,
            body: r.try_get("body")?,
            attachment,
            created_at: r.try_get("created_at")?,
            can_delete,
            hearts: r.try_get("hearts")?,
            my_heart: hearted.contains(&id),
            reply_count: r.try_get("reply_count")?,
            locked: r.try_get::<Option<String>, _>("locked_at")?.is_some(),
            id,
        });
    }
    Ok(out)
}

pub(crate) async fn load_post(state: &AppState, id: &str, viewer: Option<&str>) -> AppResult<Post> {
    let row = sqlx::query(&format!("{POST_SELECT} WHERE p.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(NOT_FOUND))?;
    posts_for(state, std::slice::from_ref(&row), viewer)
        .await?
        .pop()
        .ok_or_else(|| AppError::not_found(NOT_FOUND))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/posts` (🔒): auth → JSON → `Limit::Post` (429) → body rules (422) → attachment
/// (422/404) → guarded insert under the 24-hour cap (422) + `postCreated` event → 201.
pub async fn create_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreatePostBody>,
) -> AppResult<(StatusCode, Json<Post>)> {
    limit_user(&state, Limit::Post, &user.id)?;
    let body = validate_post_body(&req.body)?;
    if req.game_id.is_some() && req.collection_id.is_some() {
        return Err(AppError::validation(
            "A post can have at most one attachment",
        ));
    }
    let (attachment_type, game_id, collection_id) = if let Some(gid) = req.game_id.as_deref() {
        let game = fetch_visible_game(&state, gid, Some(&user.id)).await?;
        if !game.published {
            return Err(AppError::validation("Only published games can be attached"));
        }
        (Some("game"), Some(game.id), None)
    } else if let Some(cid) = req.collection_id.as_deref() {
        let admin = is_admin(&state, Some(&user.id)).await?;
        let c = load_collection(&state, cid, Some(&user.id), admin).await?;
        if c.visibility != "public" {
            return Err(AppError::validation(
                "Only public collections can be attached",
            ));
        }
        (Some("collection"), None, Some(c.id))
    } else {
        (None, None, None)
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now_dt = Utc::now();
    let now = now_dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let cutoff =
        (now_dt - Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let inserted = sqlx::query(GUARDED_INSERT_SQL)
        .bind(&id)
        .bind(&user.id)
        .bind(&body)
        .bind(attachment_type)
        .bind(&game_id)
        .bind(&collection_id)
        .bind(&now)
        .bind(&cutoff)
        .bind(POSTS_PER_DAY_MAX)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if inserted == 0 {
        return Err(AppError::validation(format!(
            "You can post at most {POSTS_PER_DAY_MAX} times in 24 hours"
        )));
    }
    activity::record_post_created(&mut tx, &user.id, &id, &now).await;
    tx.commit().await?;

    let post = load_post(&state, &id, Some(&user.id)).await?;
    Ok((StatusCode::CREATED, Json(post)))
}

/// `GET /api/posts/{id}` (🔓, no rate limit).
pub async fn get_post(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Post>> {
    Ok(Json(load_post(&state, &id, viewer.id()).await?))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PostsQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

/// `GET /api/users/{username}/posts?page=&perPage=` (🔓, no rate limit): every post of the
/// user, newest first. The user is looked up before paging is parsed.
pub async fn list_user_posts(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<PostsQuery>,
) -> AppResult<Json<Page<Post>>> {
    let author: String = sqlx::query_scalar("SELECT id FROM users WHERE username_lower = ?")
        .bind(username.to_lowercase())
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("User"))?;
    let (page, per_page) = parse_paging(
        query.page.as_deref(),
        query.per_page.as_deref(),
        POSTS_PER_PAGE_DEFAULT,
    )?;
    let per_page = per_page.clamp(1, POSTS_PER_PAGE_MAX);
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM posts WHERE author_id = ?1")
        .bind(&author)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&user_posts_page_sql())
        .bind(&author)
        .bind(per_page)
        .bind(page_offset(page, per_page))
        .fetch_all(&state.db)
        .await?;
    let items = posts_for(&state, &rows, viewer.id()).await?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

/// Delete a post (`DELETE /api/posts/{id}` and the report `delete` action), in one
/// transaction: open `post` reports on it and (F031) open `postReply` reports on its replies
/// are resolved with `delete`, then the row is deleted. Cascades: its `postCreated` event, its
/// replies, hearts and both post kinds' notifications. An unknown id is a no-op.
pub async fn remove_post(state: &AppState, id: &str) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2 \
         WHERE status = 'open' AND ((target_type = 'post' AND target_id = ?1) \
           OR (target_type = 'postReply' AND target_id IN \
             (SELECT id FROM post_replies WHERE post_id = ?1)))",
    )
    .bind(id)
    .bind(now_rfc3339())
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM posts WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// `DELETE /api/posts/{id}` (🔒 author or admin, no rate limit): 404 → 403 → 204.
pub async fn delete_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    let author: String = sqlx::query_scalar("SELECT author_id FROM posts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(NOT_FOUND))?;
    if author != user.id && !is_admin(&state, Some(&user.id)).await? {
        return Err(AppError::forbidden());
    }
    remove_post(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// F031 hearts and lock
// ---------------------------------------------------------------------------

/// The parts of a post the F031 handlers check.
#[derive(Debug, Clone)]
pub(crate) struct PostMeta {
    pub author_id: String,
    pub locked: bool,
}

/// F031: the post's author and lock state; 404 `Post not found` for an unknown id.
pub(crate) async fn post_meta(state: &AppState, id: &str) -> AppResult<PostMeta> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT author_id, locked_at FROM posts WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let (author_id, locked_at) = row.ok_or_else(|| AppError::not_found(NOT_FOUND))?;
    Ok(PostMeta {
        author_id,
        locked: locked_at.is_some(),
    })
}

/// The post's current heart count; 404 when it vanished meanwhile.
async fn post_hearts(state: &AppState, id: &str) -> AppResult<i64> {
    sqlx::query_scalar("SELECT hearts FROM posts WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(NOT_FOUND))
}

/// `PUT /api/posts/{id}/heart` (🔒, idempotent): auth → 404 → `Limit::Heart` (429) → own post
/// (422) → insert (a new heart notifies the author, actor dedupe) → `{ hearted: true, hearts }`.
pub async fn heart_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<PostHeartResponse>> {
    let meta = post_meta(&state, &id).await?;
    limit_user(&state, Limit::Heart, &user.id)?;
    if meta.author_id == user.id {
        return Err(AppError::validation("You can't heart your own post"));
    }
    // Never INSERT OR REPLACE: its implicit delete would skip the counter trigger.
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO post_hearts (post_id, user_id, created_at) \
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?1)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted > 0 {
        notif::notify_pool(
            &state.db,
            &NewNotification {
                recipient_id: meta.author_id.clone(),
                kind: Kind::PostHeart,
                group_key: post_group(&id),
                game_id: None,
                comment_id: None,
                actor_id: user.id.clone(),
                event_comment_id: None,
                event_screenshot_id: None,
                dedupe: Dedupe::Actor,
                thread_id: None,
                collection_id: None,
                post_id: Some(id.clone()),
                event_post_reply_id: None,
                now: Utc::now(),
            },
        )
        .await;
    }
    Ok(Json(PostHeartResponse {
        hearted: true,
        hearts: post_hearts(&state, &id).await?,
    }))
}

/// `DELETE /api/posts/{id}/heart` (🔒, idempotent): auth → 404 → `Limit::Heart` (429) → delete
/// (a removed heart retracts the author's unread event) → `{ hearted: false, hearts }`.
pub async fn unheart_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<PostHeartResponse>> {
    let meta = post_meta(&state, &id).await?;
    limit_user(&state, Limit::Heart, &user.id)?;
    let removed = sqlx::query("DELETE FROM post_hearts WHERE post_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed > 0 {
        notif::retract_pool(
            &state.db,
            &meta.author_id,
            Kind::PostHeart,
            &post_group(&id),
            &user.id,
        )
        .await;
    }
    Ok(Json(PostHeartResponse {
        hearted: false,
        hearts: post_hearts(&state, &id).await?,
    }))
}

/// Shared by lock / unlock: auth → 404 → author or admin (403) → `Limit::ThreadTools` (429).
async fn check_lock_rights(state: &AppState, user: &AuthUser, id: &str) -> AppResult<()> {
    let meta = post_meta(state, id).await?;
    if meta.author_id != user.id && !is_admin(state, Some(&user.id)).await? {
        return Err(AppError::forbidden());
    }
    limit_user(state, Limit::ThreadTools, &user.id)?;
    Ok(())
}

/// `PUT /api/posts/{id}/lock` (🔒 author/admin, idempotent): turn replies off. Keeps the first
/// `locked_at`. No notifications.
pub async fn lock_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Post>> {
    check_lock_rights(&state, &user, &id).await?;
    sqlx::query("UPDATE posts SET locked_at = COALESCE(locked_at, ?2) WHERE id = ?1")
        .bind(&id)
        .bind(now_rfc3339())
        .execute(&state.db)
        .await?;
    Ok(Json(load_post(&state, &id, Some(&user.id)).await?))
}

/// `DELETE /api/posts/{id}/lock` (🔒 author/admin, idempotent): turn replies back on.
pub async fn unlock_post(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Post>> {
    check_lock_rights(&state, &user, &id).await?;
    sqlx::query("UPDATE posts SET locked_at = NULL WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(Json(load_post(&state, &id, Some(&user.id)).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(raw: &str) -> String {
        match validate_post_body(raw) {
            Err(AppError::Validation(m)) => m,
            other => panic!("expected a validation error for {raw:?}, got {other:?}"),
        }
    }

    #[test]
    fn normalises_and_trims() {
        assert_eq!(validate_post_body("  hi\r\nthere  ").unwrap(), "hi\nthere");
        assert_eq!(validate_post_body("a\rb").unwrap(), "a\nb");
        assert_eq!(validate_post_body("\n\nx\n\n").unwrap(), "x");
        // Interior blank lines are kept.
        assert_eq!(validate_post_body("a\n\nb").unwrap(), "a\n\nb");
    }

    #[test]
    fn length_counts_code_points() {
        let len = "body must be 1–500 characters";
        assert_eq!(msg(""), len);
        assert_eq!(msg("   \r\n\t "), len);
        assert_eq!(msg(&"é".repeat(501)), len);
        assert!(validate_post_body(&"é".repeat(500)).is_ok());
        assert!(validate_post_body(&"😀".repeat(500)).is_ok());
        assert!(validate_post_body("x").is_ok());
    }

    #[test]
    fn line_cap_boundary() {
        let twelve = ["l"; 12].join("\n");
        assert!(validate_post_body(&twelve).is_ok());
        let thirteen = ["l"; 13].join("\r\n");
        assert_eq!(msg(&thirteen), "body must be at most 12 lines");
        // Trailing newlines are trimmed before counting.
        assert!(validate_post_body(&format!("{twelve}\n\n\n")).is_ok());
    }

    #[test]
    fn forbidden_characters() {
        let plain = "body must be plain text";
        for s in [
            "a\tb",
            "a\u{202E}b",
            "a\u{200B}b",
            "a\u{7}b",
            "a\u{7F}b",
            "a\u{9F}b",
            "a\u{2060}b",
            "a\u{2066}b",
            "a\u{FEFF}b",
            "a\u{061C}b",
            "a\u{115F}b",
            "a\u{1160}b",
            "a\u{180E}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "a\u{3164}b",
            "a\u{FFA0}b",
        ] {
            assert_eq!(msg(s), plain, "{s:?}");
        }
        assert!(validate_post_body("a\nb").is_ok());
        // Review 11: U+2028 can't be used to get around the 12-line cap.
        let sep = ["l"; 13].join("\u{2028}");
        assert_eq!(msg(&sep), plain);
    }

    #[test]
    fn review11_extended_set_and_separator_bypass() {
        let plain = "body must be plain text";
        // Each character added to the shared set in review 11 (L2).
        for c in [
            '\u{61C}', '\u{115F}', '\u{1160}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{3164}',
            '\u{FFA0}',
        ] {
            assert_eq!(msg(&format!("a{c}b")), plain, "U+{:04X}", c as u32);
        }
        // 30 lines joined with LINE SEPARATOR / PARAGRAPH SEPARATOR no longer get past the
        // 12-line cap.
        assert_eq!(msg(&["l"; 30].join("\u{2028}")), plain);
        assert_eq!(msg(&["l"; 30].join("\u{2029}")), plain);
        // Their neighbours stay allowed.
        for c in [
            '\u{61B}', '\u{61D}', '\u{115E}', '\u{1161}', '\u{180D}', '\u{180F}', '\u{2027}',
            '\u{3163}', '\u{3165}', '\u{FF9F}', '\u{FFA1}',
        ] {
            assert!(
                validate_post_body(&format!("a{c}b")).is_ok(),
                "U+{:04X}",
                c as u32
            );
        }
    }

    #[test]
    fn rule_order() {
        // Length before lines before characters.
        let long_lines = format!("x\ty{}", "\na".repeat(300));
        assert_eq!(msg(&long_lines), "body must be 1–500 characters");
        let many_lines_tab = format!("x\ty{}", "\na".repeat(13));
        assert_eq!(msg(&many_lines_tab), "body must be at most 12 lines");
    }
}
