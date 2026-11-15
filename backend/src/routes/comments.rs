//! Game comments, F006 replies (one level) and hearts.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{
    Comment, CommentContext, CommentListPage, CommentThread, HeartResponse, Page, now_rfc3339,
    user_ref_from_row,
};
use crate::notifications::{self as notif, Kind, NewNotification};
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_visible_game, limit_user, parse_paging};
use crate::routes::screenshots::is_admin;

pub const COMMENT_MAX: usize = 2000;
/// F006: replies per thread.
pub const REPLY_CAP: i64 = 200;
/// F006: replies previewed under each thread in the list and in `CommentContext`.
pub const REPLY_PREVIEW: i64 = 3;

/// F006 read shape (docs/ARCHITECTURE.md § F006). Binds: `?1` = viewer id or NULL, `?2` = 1
/// when the viewer is an admin. Callers continue numbering at `?3`.
fn comment_select() -> &'static str {
    "SELECT c.id, c.game_id, c.parent_id, c.body, c.created_at, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version, \
     r.id AS r_id, r.username AS r_username, r.display_name AS r_display_name, \
     r.avatar_ext AS r_avatar_ext, r.avatar_version AS r_avatar_version, \
     (c.user_id = g.owner_id) AS is_creator, \
     (SELECT COUNT(*) FROM comment_hearts h WHERE h.comment_id = c.id) AS hearts, \
     EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id AND h.user_id = ?1) \
       AS my_heart, \
     EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id \
       AND h.user_id = g.owner_id) AS creator_heart, \
     (?1 IS NOT NULL AND (?2 = 1 OR c.user_id = ?1 OR g.owner_id = ?1)) AS can_delete \
     FROM comments c \
     JOIN users u ON u.id = c.user_id \
     JOIN games g ON g.id = c.game_id \
     LEFT JOIN users r ON r.id = c.reply_to_user_id"
}

/// Who is reading: drives `myHeart` and `canDelete`.
struct Viewer {
    id: Option<String>,
    admin: bool,
}

impl Viewer {
    async fn load(state: &AppState, id: Option<&str>) -> AppResult<Self> {
        Ok(Self {
            id: id.map(str::to_string),
            admin: is_admin(state, id).await?,
        })
    }

    fn admin_flag(&self) -> i64 {
        i64::from(self.admin)
    }
}

fn comment_from_row(row: &SqliteRow) -> Result<Comment, sqlx::Error> {
    let reply_to = match row.try_get::<Option<String>, _>("r_id")? {
        Some(_) => Some(user_ref_from_row(row, "r_")?),
        None => None,
    };
    Ok(Comment {
        id: row.try_get("id")?,
        game_id: row.try_get("game_id")?,
        author: user_ref_from_row(row, "a_")?,
        body: row.try_get("body")?,
        created_at: row.try_get("created_at")?,
        parent_id: row.try_get("parent_id")?,
        reply_to,
        is_creator: row.try_get("is_creator")?,
        hearts: row.try_get("hearts")?,
        my_heart: row.try_get("my_heart")?,
        creator_heart: row.try_get("creator_heart")?,
        can_delete: row.try_get("can_delete")?,
    })
}

fn comments_from_rows(rows: &[SqliteRow]) -> Result<Vec<Comment>, sqlx::Error> {
    rows.iter().map(comment_from_row).collect()
}

async fn load_comment(state: &AppState, viewer: &Viewer, id: &str) -> AppResult<Option<Comment>> {
    let row = sqlx::query(&format!("{} WHERE c.id = ?3", comment_select()))
        .bind(&viewer.id)
        .bind(viewer.admin_flag())
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.as_ref().map(comment_from_row).transpose()?)
}

/// Attach reply previews (≤ 3, oldest first) and reply counts to top-level comments: one
/// preview query and one grouped count query for the whole set.
async fn into_threads(
    state: &AppState,
    viewer: &Viewer,
    roots: Vec<Comment>,
) -> AppResult<Vec<CommentThread>> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let ids = serde_json::to_string(&roots.iter().map(|c| c.id.as_str()).collect::<Vec<_>>())
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let rows = sqlx::query(&format!(
        "WITH p AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY created_at, \
         rowid) AS rn FROM comments WHERE parent_id IN (SELECT value FROM json_each(?3))) \
         {} JOIN p ON p.id = c.id WHERE p.rn <= ?4 ORDER BY c.parent_id, p.rn",
        comment_select()
    ))
    .bind(&viewer.id)
    .bind(viewer.admin_flag())
    .bind(&ids)
    .bind(REPLY_PREVIEW)
    .fetch_all(&state.db)
    .await?;
    let mut previews: HashMap<String, Vec<Comment>> = HashMap::new();
    for c in comments_from_rows(&rows)? {
        if let Some(p) = c.parent_id.clone() {
            previews.entry(p).or_default().push(c);
        }
    }
    let counts: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
        "SELECT parent_id, COUNT(*) FROM comments \
         WHERE parent_id IN (SELECT value FROM json_each(?1)) GROUP BY parent_id",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .collect();
    Ok(roots
        .into_iter()
        .map(|comment| CommentThread {
            reply_count: counts.get(&comment.id).copied().unwrap_or(0),
            replies: previews.remove(&comment.id).unwrap_or_default(),
            comment,
        })
        .collect())
}

/// The comment's game must be visible to the viewer (`GET /api/games/{id}` rules); a hidden
/// game reads as an unknown comment.
async fn ensure_visible(state: &AppState, game_id: &str, viewer: Option<&str>) -> AppResult<()> {
    fetch_visible_game(state, game_id, viewer)
        .await
        .map_err(|e| match e {
            AppError::NotFound(_) => AppError::not_found("Comment"),
            other => other,
        })?;
    Ok(())
}

/// Minimal row for permission and visibility checks.
struct CommentMeta {
    game_id: String,
    parent_id: Option<String>,
    user_id: String,
    owner_id: String,
}

async fn comment_meta(state: &AppState, id: &str) -> AppResult<CommentMeta> {
    let row = sqlx::query(
        "SELECT c.game_id, c.parent_id, c.user_id, g.owner_id FROM comments c \
         JOIN games g ON g.id = c.game_id WHERE c.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Comment"))?;
    Ok(CommentMeta {
        game_id: row.try_get("game_id")?,
        parent_id: row.try_get("parent_id")?,
        user_id: row.try_get("user_id")?,
        owner_id: row.try_get("owner_id")?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn list_comments(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<CommentListPage>> {
    fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 20)?;
    let viewer = Viewer::load(&state, viewer.id()).await?;
    let (total, total_all): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(parent_id IS NULL), 0), COUNT(*) FROM comments WHERE game_id = ?",
    )
    .bind(&game_id)
    .fetch_one(&state.db)
    .await?;
    let rows = sqlx::query(&format!(
        "{} WHERE c.game_id = ?3 AND c.parent_id IS NULL \
         ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?4 OFFSET ?5",
        comment_select()
    ))
    .bind(&viewer.id)
    .bind(viewer.admin_flag())
    .bind(&game_id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let items = into_threads(&state, &viewer, comments_from_rows(&rows)?).await?;
    Ok(Json(CommentListPage {
        items,
        total,
        page,
        per_page,
        total_all,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentBody {
    pub body: String,
    /// F006: a string, or absent / `null`. Kept as raw JSON so a wrong type is reported in the
    /// documented validation order (after visibility and the rate limit).
    #[serde(default)]
    pub parent_id: Option<serde_json::Value>,
}

pub async fn create_comment(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiJson(body): ApiJson<CommentBody>,
) -> AppResult<(StatusCode, Json<Comment>)> {
    let game = fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    limit_user(&state, Limit::Comment, &user.id)?;
    let parent_ref = match body.parent_id {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s),
        Some(_) => return Err(AppError::validation("parentId must be a string or null")),
    };
    let text = body.body.trim();
    let n = text.chars().count();
    if n == 0 || n > COMMENT_MAX {
        return Err(AppError::validation(format!(
            "Comment must be 1-{COMMENT_MAX} characters"
        )));
    }

    // Reply target: normalise to its root; `replyTo` only when answering someone else's reply.
    let (root, reply_to) = match parent_ref {
        None => (None, None),
        Some(pid) => {
            let row: Option<(String, Option<String>, String)> =
                sqlx::query_as("SELECT game_id, parent_id, user_id FROM comments WHERE id = ?")
                    .bind(&pid)
                    .fetch_optional(&state.db)
                    .await?;
            let (_, p_parent, p_author) = row
                .filter(|(g, _, _)| *g == game_id)
                .ok_or_else(|| AppError::not_found("Comment"))?;
            match p_parent {
                None => (Some(pid), None),
                Some(root) => {
                    let to = (p_author != user.id).then_some(p_author);
                    (Some(root), to)
                }
            }
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    match &root {
        None => {
            sqlx::query(
                "INSERT INTO comments (id, game_id, user_id, body, created_at) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&game_id)
            .bind(&user.id)
            .bind(text)
            .bind(&now)
            .execute(&state.db)
            .await?;
        }
        Some(root) => {
            // Guarded for the cap (and for a root deleted since the lookup), so concurrent
            // posts can't exceed it or orphan a reply.
            let done = sqlx::query(
                "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id, \
                 reply_to_user_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 \
                 WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?6) \
                 AND (SELECT COUNT(*) FROM comments WHERE parent_id = ?6) < ?8",
            )
            .bind(&id)
            .bind(&game_id)
            .bind(&user.id)
            .bind(text)
            .bind(&now)
            .bind(root)
            .bind(&reply_to)
            .bind(REPLY_CAP)
            .execute(&state.db)
            .await?
            .rows_affected();
            if done == 0 {
                let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM comments WHERE id = ?")
                    .bind(root)
                    .fetch_optional(&state.db)
                    .await?;
                return Err(match exists {
                    None => AppError::not_found("Comment"),
                    Some(_) => {
                        AppError::validation(format!("This thread has reached {REPLY_CAP} replies"))
                    }
                });
            }
        }
    }
    notify_new_comment(
        &state,
        &game_id,
        &game.owner_id,
        &user.id,
        &id,
        root.as_deref(),
        reply_to.as_deref(),
    )
    .await;
    let viewer = Viewer::load(&state, Some(&user.id)).await?;
    let comment = load_comment(&state, &viewer, &id)
        .await?
        .ok_or_else(|| AppError::not_found("Comment"))?;
    Ok((StatusCode::CREATED, Json(comment)))
}

/// F007: a top-level comment notifies the game owner (group per game); a reply notifies the
/// thread's root author and the `replyTo` user (group per thread), each at most once and never
/// the poster. Best effort: failures are logged.
async fn notify_new_comment(
    state: &AppState,
    game_id: &str,
    owner_id: &str,
    poster: &str,
    comment_id: &str,
    root: Option<&str>,
    reply_to: Option<&str>,
) {
    let now = chrono::Utc::now();
    let Some(root) = root else {
        let n = NewNotification {
            recipient_id: owner_id.to_string(),
            kind: Kind::Comment,
            group_key: notif::game_group(game_id),
            game_id: Some(game_id.to_string()),
            comment_id: None,
            actor_id: poster.to_string(),
            event_comment_id: Some(comment_id.to_string()),
            dedupe_actor: false,
            now,
        };
        notif::notify_pool(&state.db, &n).await;
        return;
    };
    let root_author: Option<String> =
        match sqlx::query_scalar("SELECT user_id FROM comments WHERE id = ?")
            .bind(root)
            .fetch_optional(&state.db)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "failed to load thread author for notifications");
                None
            }
        };
    let mut recipients: Vec<&str> = Vec::with_capacity(2);
    for r in [root_author.as_deref(), reply_to].into_iter().flatten() {
        if r != poster && !recipients.contains(&r) {
            recipients.push(r);
        }
    }
    for r in recipients {
        let n = NewNotification {
            recipient_id: r.to_string(),
            kind: Kind::Reply,
            group_key: notif::thread_group(root),
            game_id: Some(game_id.to_string()),
            comment_id: Some(root.to_string()),
            actor_id: poster.to_string(),
            event_comment_id: Some(comment_id.to_string()),
            dedupe_actor: false,
            now,
        };
        notif::notify_pool(&state.db, &n).await;
    }
}

/// `GET /api/comments/{id}`: the comment and its thread.
pub async fn get_comment(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<CommentContext>> {
    let viewer = Viewer::load(&state, viewer.id()).await?;
    let comment = load_comment(&state, &viewer, &id)
        .await?
        .ok_or_else(|| AppError::not_found("Comment"))?;
    ensure_visible(&state, &comment.game_id, viewer.id.as_deref()).await?;
    let root = match &comment.parent_id {
        None => comment.clone(),
        Some(pid) => load_comment(&state, &viewer, pid)
            .await?
            .ok_or_else(|| AppError::not_found("Comment"))?,
    };
    let thread = into_threads(&state, &viewer, vec![root])
        .await?
        .pop()
        .ok_or_else(|| AppError::not_found("Comment"))?;
    Ok(Json(CommentContext { comment, thread }))
}

/// `GET /api/comments/{id}/replies`: a thread's replies, oldest first.
pub async fn list_replies(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<Comment>>> {
    let meta = comment_meta(&state, &id).await?;
    ensure_visible(&state, &meta.game_id, viewer.id()).await?;
    if meta.parent_id.is_some() {
        return Err(AppError::validation(
            "Replies are listed for top-level comments only",
        ));
    }
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 50)?;
    let viewer = Viewer::load(&state, viewer.id()).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE parent_id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&format!(
        "{} WHERE c.parent_id = ?3 ORDER BY c.created_at, c.rowid LIMIT ?4 OFFSET ?5",
        comment_select()
    ))
    .bind(&viewer.id)
    .bind(viewer.admin_flag())
    .bind(&id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(Page {
        items: comments_from_rows(&rows)?,
        total,
        page,
        per_page,
    }))
}

/// Delete a comment (and, for a top-level comment, its replies) and resolve every open report
/// on the deleted rows, in one transaction. Hearts cascade. Shared by `DELETE
/// /api/comments/{id}` and the admin resolve `delete` action. A missing comment is a no-op.
pub async fn remove_comment(state: &AppState, id: &str) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2 \
         WHERE target_type = 'comment' AND status = 'open' \
         AND target_id IN (SELECT id FROM comments WHERE id = ?1 OR parent_id = ?1)",
    )
    .bind(id)
    .bind(now_rfc3339())
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM comments WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn delete_comment(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    let meta = comment_meta(&state, &id).await?;
    if user.id != meta.user_id
        && user.id != meta.owner_id
        && !is_admin(&state, Some(&user.id)).await?
    {
        return Err(AppError::forbidden());
    }
    remove_comment(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Checks shared by both heart handlers: comment exists, its game is visible, rate limit.
async fn heart_target(state: &AppState, user: &AuthUser, id: &str) -> AppResult<CommentMeta> {
    let meta = comment_meta(state, id).await?;
    ensure_visible(state, &meta.game_id, Some(&user.id)).await?;
    limit_user(state, Limit::Heart, &user.id)?;
    Ok(meta)
}

async fn heart_response(state: &AppState, id: &str, hearted: bool) -> AppResult<HeartResponse> {
    let (hearts, creator_heart): (i64, bool) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM comment_hearts h WHERE h.comment_id = c.id), \
         EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id \
           AND h.user_id = g.owner_id) \
         FROM comments c JOIN games g ON g.id = c.game_id WHERE c.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Comment"))?;
    Ok(HeartResponse {
        hearted,
        hearts,
        creator_heart,
    })
}

/// `PUT /api/comments/{id}/heart` (idempotent).
pub async fn heart(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<HeartResponse>> {
    let meta = heart_target(&state, &user, &id).await?;
    if meta.user_id == user.id {
        return Err(AppError::validation("You can't heart your own comment"));
    }
    let changed = sqlx::query(
        "INSERT OR IGNORE INTO comment_hearts (comment_id, user_id, created_at) \
         SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?1)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?
    .rows_affected()
        > 0;
    if changed {
        // F007: every heart notifies the author (coalesced per comment, once per hearter).
        let n = NewNotification {
            recipient_id: meta.user_id.clone(),
            kind: Kind::Heart,
            group_key: notif::comment_group(&id),
            game_id: Some(meta.game_id.clone()),
            comment_id: Some(id.clone()),
            actor_id: user.id.clone(),
            event_comment_id: None,
            dedupe_actor: true,
            now: chrono::Utc::now(),
        };
        notif::notify_pool(&state.db, &n).await;
    }
    Ok(Json(heart_response(&state, &id, true).await?))
}

/// `DELETE /api/comments/{id}/heart` (idempotent; 200 even if not hearted).
pub async fn unheart(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<HeartResponse>> {
    let meta = heart_target(&state, &user, &id).await?;
    let removed = sqlx::query("DELETE FROM comment_hearts WHERE comment_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .execute(&state.db)
        .await?
        .rows_affected()
        > 0;
    if removed {
        notif::retract_pool(
            &state.db,
            &meta.user_id,
            Kind::Heart,
            &notif::comment_group(&id),
            &user.id,
        )
        .await;
    }
    Ok(Json(heart_response(&state, &id, false).await?))
}
