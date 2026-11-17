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
    Comment, CommentContext, CommentListPage, CommentMode, CommentSettings, CommentSettingsView,
    CommentThread, GameRow, HeartResponse, Page, SLOW_MODE_SECS, ThreadState, now_rfc3339,
    user_ref_from_row,
};
use crate::notifications::{self as notif, Dedupe, Kind, NewNotification};
use crate::ratelimit::{ClientIp, Limit, key_for};
use crate::routes::games::{fetch_visible_game, limit_user, parse_paging};
use crate::routes::screenshots::is_admin;

pub const COMMENT_MAX: usize = 2000;
/// F006: replies per thread.
pub const REPLY_CAP: i64 = 200;
/// F006: replies previewed under each thread in the list and in `CommentContext`.
pub const REPLY_PREVIEW: i64 = 3;
/// F017: a reply to a locked thread by someone who isn't the game owner or an admin.
const THREAD_LOCKED: &str = "This thread is locked";
/// F020 step 5b: mode `off`, any post by someone who isn't exempt.
const COMMENTS_OFF: &str = "Comments are turned off for this game";
/// F020 step 5b: mode `repliesOnly`, a top-level post by someone who isn't exempt.
const NEW_COMMENTS_OFF: &str = "New comments are turned off for this game";

/// RFC3339 with millis and `Z`, the format of `now_rfc3339()` (string order is chronological).
fn fmt_time(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// F020: whole seconds left of a slow-mode interval that started at `last`,
/// `ceil(last + secs − now)` clamped to `[0, secs]`. A `last` later than `now` (the clock
/// stepped back) counts as expired, matching the claim in `create_comment` (L1). An
/// unparsable `last` counts as no wait.
fn slow_mode_wait(last: &str, secs: i64, now: chrono::DateTime<chrono::Utc>) -> i64 {
    let Ok(last) = chrono::DateTime::parse_from_rfc3339(last) else {
        tracing::warn!(
            last,
            "unparsable comment_post_times.last_posted_at; no wait"
        );
        return 0;
    };
    if last.timestamp_millis() > now.timestamp_millis() {
        return 0;
    }
    let left_ms = last.timestamp_millis() + secs * 1000 - now.timestamp_millis();
    let left = if left_ms <= 0 {
        0
    } else {
        (left_ms + 999) / 1000
    };
    left.clamp(0, secs)
}

/// F020/F017: the poster is the game's current owner or an admin. `admin` caches the
/// `is_admin` lookup so a request loads it at most once.
async fn exempt(
    state: &AppState,
    user_id: &str,
    game: &GameRow,
    admin: &mut Option<bool>,
) -> AppResult<bool> {
    if user_id == game.owner_id {
        return Ok(true);
    }
    if let Some(a) = *admin {
        return Ok(a);
    }
    let a = is_admin(state, Some(user_id)).await?;
    *admin = Some(a);
    Ok(a)
}

/// F006 read shape (docs/ARCHITECTURE.md § F006, plus the F017 `pinned`, `locked` and
/// `can_moderate` columns and the F018 `thread_muted` column). Binds: `?1` = viewer id or NULL, `?2` = 1
/// when the viewer is an admin. Callers continue numbering at `?3`.
fn comment_select() -> &'static str {
    "SELECT c.id, c.game_id, c.parent_id, c.body, c.created_at, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version, \
     r.id AS r_id, r.username AS r_username, r.display_name AS r_display_name, \
     r.avatar_ext AS r_avatar_ext, r.avatar_version AS r_avatar_version, \
     (c.user_id = g.owner_id) AS is_creator, \
     c.hearts AS hearts, \
     EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id AND h.user_id = ?1) \
       AS my_heart, \
     EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id \
       AND h.user_id = g.owner_id) AS creator_heart, \
     (?1 IS NOT NULL AND (?2 = 1 OR c.user_id = ?1 OR g.owner_id = ?1)) AS can_delete, \
     (c.pinned_at IS NOT NULL) AS pinned, \
     (c.parent_id IS NULL AND c.locked_at IS NOT NULL) AS locked, \
     (?1 IS NOT NULL AND c.parent_id IS NULL AND (?2 = 1 OR g.owner_id = ?1)) AS can_moderate, \
     (?1 IS NOT NULL AND c.parent_id IS NULL AND EXISTS (SELECT 1 FROM notification_mutes m \
       WHERE m.user_id = ?1 AND m.game_id = c.game_id AND m.thread_id = c.id)) AS thread_muted \
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
        pinned: row.try_get("pinned")?,
        locked: row.try_get("locked")?,
        can_moderate: row.try_get("can_moderate")?,
        thread_muted: row.try_get("thread_muted")?,
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

/// F017: `GET /api/games/{id}/comments` query (`PageQuery` + `sort`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommentsQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
    pub sort: Option<String>,
}

/// F017 thread order.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommentSort {
    New,
    Top,
}

impl CommentSort {
    /// Absent, empty or `new` → newest; `top` → top; anything else → 400.
    fn parse(raw: Option<&str>) -> AppResult<Self> {
        match raw {
            None | Some("") | Some("new") => Ok(Self::New),
            Some("top") => Ok(Self::Top),
            Some(other) => Err(AppError::BadRequest(format!(
                "Unknown sort '{}' (expected new or top)",
                other.chars().take(40).collect::<String>()
            ))),
        }
    }

    fn order_by(self) -> &'static str {
        match self {
            Self::New => "c.created_at DESC, c.rowid DESC",
            // Review 6 L2: the trigger-maintained `comments.hearts` column, read through
            // `idx_comments_game_hearts` (no correlated count, no temp B-tree).
            Self::Top => "c.hearts DESC, c.created_at DESC, c.rowid DESC",
        }
    }
}

pub async fn list_comments(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ip: ClientIp,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ListCommentsQuery>,
) -> AppResult<Json<CommentListPage>> {
    // Review 6 L2: first, like the other limited anonymous reads (leaderboard, scores).
    state
        .limiter
        .check(Limit::CommentList, &key_for(viewer.id(), &ip))?;
    let game = fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let sort = CommentSort::parse(query.sort.as_deref())?;
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 20)?;
    let viewer = Viewer::load(&state, viewer.id()).await?;
    let settings = settings_view(&state, &game, &viewer).await?;
    let (total, total_all): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(parent_id IS NULL AND pinned_at IS NULL), 0), COUNT(*) \
         FROM comments WHERE game_id = ?",
    )
    .bind(&game_id)
    .fetch_one(&state.db)
    .await?;
    let rows = sqlx::query(&format!(
        "{} WHERE c.game_id = ?3 AND c.parent_id IS NULL AND c.pinned_at IS NULL \
         ORDER BY {} LIMIT ?4 OFFSET ?5",
        comment_select(),
        sort.order_by()
    ))
    .bind(&viewer.id)
    .bind(viewer.admin_flag())
    .bind(&game_id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let pinned_row = sqlx::query(&format!(
        "{} WHERE c.game_id = ?3 AND c.pinned_at IS NOT NULL",
        comment_select()
    ))
    .bind(&viewer.id)
    .bind(viewer.admin_flag())
    .bind(&game_id)
    .fetch_optional(&state.db)
    .await?;
    // One `into_threads` call for the pinned root and the page (one preview query, one count
    // query), then split the pinned thread off the front.
    let has_pinned = pinned_row.is_some();
    let mut roots = Vec::with_capacity(rows.len() + 1);
    if let Some(row) = &pinned_row {
        roots.push(comment_from_row(row)?);
    }
    roots.extend(comments_from_rows(&rows)?);
    let mut items = into_threads(&state, &viewer, roots).await?;
    let pinned = if has_pinned && !items.is_empty() {
        Some(items.remove(0))
    } else {
        None
    };
    Ok(Json(CommentListPage {
        items,
        total,
        page,
        per_page,
        total_all,
        pinned,
        settings,
    }))
}

/// F020 `CommentListPage.settings`: `canManage` = owner or admin; `waitSecs` only for a
/// signed-in, non-managing viewer while slow mode is on (one primary-key lookup).
async fn settings_view(
    state: &AppState,
    game: &GameRow,
    viewer: &Viewer,
) -> AppResult<CommentSettingsView> {
    let settings = game.comment_settings();
    let can_manage = viewer
        .id
        .as_deref()
        .is_some_and(|id| viewer.admin || id == game.owner_id);
    let mut wait_secs = 0;
    if let Some(uid) = viewer.id.as_deref()
        && !can_manage
        && settings.slow_mode_secs > 0
    {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
        )
        .bind(&game.id)
        .bind(uid)
        .fetch_optional(&state.db)
        .await?;
        if let Some(last) = last {
            wait_secs = slow_mode_wait(&last, settings.slow_mode_secs, chrono::Utc::now());
        }
    }
    Ok(CommentSettingsView {
        settings,
        can_manage,
        wait_secs,
    })
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

    // F020 5b: the game's comment mode (owner and admins exempt). Not repeated in the
    // transaction: a post racing a settings change may land (accepted, API § F020).
    let mut admin: Option<bool> = None;
    let mode_blocks = match game.comment_mode {
        CommentMode::On => None,
        CommentMode::Off => Some(COMMENTS_OFF),
        CommentMode::RepliesOnly if parent_ref.is_none() => Some(NEW_COMMENTS_OFF),
        CommentMode::RepliesOnly => None,
    };
    if let Some(msg) = mode_blocks
        && !exempt(&state, &user.id, &game, &mut admin).await?
    {
        return Err(AppError::validation(msg));
    }

    // Reply target: normalise to its root; `replyTo` only when answering someone else's reply.
    // F017: `root_locked` is the root's lock state at lookup time.
    let (root, reply_to, root_locked) = match parent_ref {
        None => (None, None, false),
        Some(pid) => {
            let row: Option<(String, Option<String>, String, bool)> = sqlx::query_as(
                "SELECT c.game_id, c.parent_id, c.user_id, \
                 (CASE WHEN c.parent_id IS NULL THEN c.locked_at ELSE r.locked_at END) \
                   IS NOT NULL \
                 FROM comments c LEFT JOIN comments r ON r.id = c.parent_id WHERE c.id = ?",
            )
            .bind(&pid)
            .fetch_optional(&state.db)
            .await?;
            let (_, p_parent, p_author, locked) = row
                .filter(|(g, _, _, _)| *g == game_id)
                .ok_or_else(|| AppError::not_found("Comment"))?;
            match p_parent {
                None => (Some(pid), None, locked),
                Some(root) => {
                    let to = (p_author != user.id).then_some(p_author);
                    (Some(root), to, locked)
                }
            }
        }
    };
    // F017: the game owner and admins bypass thread locks. `is_admin` is loaded only for a
    // reply by someone other than the owner (and at most once per request).
    let moderator = root.is_some() && exempt(&state, &user.id, &game, &mut admin).await?;
    if root_locked && !moderator {
        return Err(AppError::validation(THREAD_LOCKED));
    }

    // F020 6c: slow mode applies unless it is off or the poster is exempt.
    let slow_secs = game.comment_slow_mode_secs;
    let check_slow = slow_secs > 0 && !exempt(&state, &user.id, &game, &mut admin).await?;

    let id = uuid::Uuid::new_v4().to_string();
    let now_dt = chrono::Utc::now();
    // One value for `comments.created_at` and `comment_post_times.last_posted_at`.
    let now = fmt_time(now_dt);
    let cutoff = fmt_time(now_dt - chrono::Duration::seconds(slow_secs));
    // One transaction: the claim, then the insert, so a rejected post never consumes the slot.
    // `BEGIN IMMEDIATE` takes the write lock up front, so two posts by one user serialise and
    // the second one sees the first one's claim. L1: a stored time later than `now` (the clock
    // stepped back) counts as expired, as in `slow_mode_wait`; both are the same fixed-width
    // RFC 3339 UTC format, so the text comparison is chronological.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let claimed = sqlx::query(
        "INSERT INTO comment_post_times (game_id, user_id, last_posted_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (game_id, user_id) DO UPDATE SET last_posted_at = excluded.last_posted_at \
         WHERE ?4 = 1 OR comment_post_times.last_posted_at <= ?5 \
         OR comment_post_times.last_posted_at > ?3",
    )
    .bind(&game_id)
    .bind(&user.id)
    .bind(&now)
    .bind(i64::from(!check_slow))
    .bind(&cutoff)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if claimed == 0 {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
        )
        .bind(&game_id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.rollback().await?;
        let left = last.map_or(0, |l| slow_mode_wait(&l, slow_secs, now_dt));
        let retry_after = left.clamp(1, slow_secs);
        return Err(AppError::SlowMode {
            retry_after: u64::try_from(retry_after).unwrap_or(1),
        });
    }
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
            .execute(&mut *tx)
            .await?;
        }
        Some(root) => {
            // Guarded for the cap, the F017 lock (closes the race with a lock) and a root
            // deleted since the lookup, so concurrent posts can't exceed the cap, slip into a
            // locked thread or orphan a reply.
            let done = sqlx::query(
                "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id, \
                 reply_to_user_id) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 \
                 WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?6) \
                 AND (?9 = 1 OR (SELECT locked_at FROM comments WHERE id = ?6) IS NULL) \
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
            .bind(i64::from(moderator))
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if done == 0 {
                // Roll the claim back before the re-read (it uses the pool).
                tx.rollback().await?;
                let locked: Option<bool> =
                    sqlx::query_scalar("SELECT locked_at IS NOT NULL FROM comments WHERE id = ?")
                        .bind(root)
                        .fetch_optional(&state.db)
                        .await?;
                return Err(match locked {
                    None => AppError::not_found("Comment"),
                    Some(true) if !moderator => AppError::validation(THREAD_LOCKED),
                    Some(_) => {
                        AppError::validation(format!("This thread has reached {REPLY_CAP} replies"))
                    }
                });
            }
        }
    }
    tx.commit().await?;
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
    let viewer = Viewer {
        id: Some(user.id.clone()),
        admin: match admin {
            Some(a) => a,
            None => is_admin(&state, Some(&user.id)).await?,
        },
    };
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
            dedupe: Dedupe::None,
            thread_id: None,
            collection_id: None,
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
            dedupe: Dedupe::None,
            thread_id: Some(root.to_string()),
            collection_id: None,
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
        "SELECT c.hearts, \
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
            dedupe: Dedupe::Actor,
            thread_id: Some(meta.parent_id.clone().unwrap_or_else(|| id.clone())),
            collection_id: None,
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

/// F017: which thread tool a request uses (only for the reply error message).
#[derive(Clone, Copy)]
enum Tool {
    Pin,
    Lock,
}

/// Checks shared by the four F017 thread-tool handlers, in the API § F017 order: comment exists
/// and its game is visible (404) → caller is the game's current owner or an admin (403) →
/// `Limit::ThreadTools` (429) → top-level comment (422). Auth (401) is the `AuthUser`
/// extractor.
async fn thread_tool_target(
    state: &AppState,
    user: &AuthUser,
    id: &str,
    tool: Tool,
) -> AppResult<CommentMeta> {
    let meta = comment_meta(state, id).await?;
    ensure_visible(state, &meta.game_id, Some(&user.id)).await?;
    if user.id != meta.owner_id && !is_admin(state, Some(&user.id)).await? {
        return Err(AppError::forbidden());
    }
    limit_user(state, Limit::ThreadTools, &user.id)?;
    if meta.parent_id.is_some() {
        return Err(AppError::validation(match tool {
            Tool::Pin => "Only top-level comments can be pinned",
            Tool::Lock => "Only top-level comments can be locked",
        }));
    }
    Ok(meta)
}

/// Run a single-row update on a top-level comment that `RETURNING`s
/// `(pinned_at IS NOT NULL, locked_at IS NOT NULL)`; no row (deleted meanwhile) → 404.
async fn update_thread_state(
    state: &AppState,
    sql: &str,
    id: &str,
    now: Option<&str>,
) -> AppResult<ThreadState> {
    let mut q = sqlx::query_as::<_, (bool, bool)>(sql);
    if let Some(now) = now {
        q = q.bind(now);
    }
    let (pinned, locked) = q
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("Comment"))?;
    Ok(ThreadState {
        id: id.to_string(),
        pinned,
        locked,
        unpinned_id: None,
    })
}

/// `PUT /api/comments/{id}/pin` (idempotent). Unpins the game's other pinned comment, if any,
/// in the same transaction and reports it in `unpinnedId`.
pub async fn pin(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<ThreadState>> {
    let meta = thread_tool_target(&state, &user, &id, Tool::Pin).await?;
    // F018 reads before it writes, so the transaction takes the write lock up front.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    // F018: the state before this request (an idempotent re-PUT never notifies or restores).
    let before: Option<(bool, String)> =
        sqlx::query_as("SELECT pinned_at IS NOT NULL, user_id FROM comments WHERE id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let unpinned: Option<(String, String)> = sqlx::query_as(
        "UPDATE comments SET pinned_at = NULL \
         WHERE game_id = ?1 AND pinned_at IS NOT NULL AND id <> ?2 RETURNING id, user_id",
    )
    .bind(&meta.game_id)
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .next();
    // Dropping `tx` on the 404 path rolls the unpin back.
    let (pinned, locked): (bool, bool) = sqlx::query_as(
        "UPDATE comments SET pinned_at = COALESCE(pinned_at, ?1) \
         WHERE id = ?2 AND parent_id IS NULL \
         RETURNING pinned_at IS NOT NULL, locked_at IS NOT NULL",
    )
    .bind(now_rfc3339())
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Comment"))?;
    tx.commit().await?;
    // F018, after the commit and best effort: notify the author when this request pinned the
    // comment (once per comment: group dedupe; never the pinner), then withdraw the replaced
    // pin's unread notification.
    if let Some((false, author)) = &before {
        let n = NewNotification {
            recipient_id: author.clone(),
            kind: Kind::Pinned,
            group_key: notif::pin_group(&id),
            game_id: Some(meta.game_id.clone()),
            comment_id: Some(id.clone()),
            actor_id: user.id.clone(),
            event_comment_id: None,
            dedupe: Dedupe::Group,
            thread_id: Some(id.clone()),
            collection_id: None,
            now: chrono::Utc::now(),
        };
        notif::notify_pool(&state.db, &n).await;
    }
    if let Some((old, author)) = &unpinned {
        notif::withdraw_pool(&state.db, author, Kind::Pinned, &notif::pin_group(old)).await;
    }
    Ok(Json(ThreadState {
        id,
        pinned,
        locked,
        unpinned_id: unpinned.map(|(old, _)| old),
    }))
}

/// `DELETE /api/comments/{id}/pin` (idempotent; 200 even if not pinned).
pub async fn unpin(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<ThreadState>> {
    thread_tool_target(&state, &user, &id, Tool::Pin).await?;
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    // F018: whether this request changes the row from pinned to unpinned.
    let before: Option<(bool, String)> =
        sqlx::query_as("SELECT pinned_at IS NOT NULL, user_id FROM comments WHERE id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let (pinned, locked): (bool, bool) = sqlx::query_as(
        "UPDATE comments SET pinned_at = NULL WHERE id = ?1 AND parent_id IS NULL \
         RETURNING pinned_at IS NOT NULL, locked_at IS NOT NULL",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Comment"))?;
    tx.commit().await?;
    // F018, after the commit and best effort: withdraw the author's unread pin notification.
    if let Some((true, author)) = &before {
        notif::withdraw_pool(&state.db, author, Kind::Pinned, &notif::pin_group(&id)).await;
    }
    Ok(Json(ThreadState {
        id,
        pinned,
        locked,
        unpinned_id: None,
    }))
}

/// `PUT /api/comments/{id}/lock` (idempotent).
pub async fn lock(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<ThreadState>> {
    thread_tool_target(&state, &user, &id, Tool::Lock).await?;
    let now = now_rfc3339();
    let st = update_thread_state(
        &state,
        "UPDATE comments SET locked_at = COALESCE(locked_at, ?1) \
         WHERE id = ?2 AND parent_id IS NULL \
         RETURNING pinned_at IS NOT NULL, locked_at IS NOT NULL",
        &id,
        Some(&now),
    )
    .await?;
    Ok(Json(st))
}

/// `DELETE /api/comments/{id}/lock` (idempotent; 200 even if not locked).
pub async fn unlock(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<ThreadState>> {
    thread_tool_target(&state, &user, &id, Tool::Lock).await?;
    let st = update_thread_state(
        &state,
        "UPDATE comments SET locked_at = NULL WHERE id = ?1 AND parent_id IS NULL \
         RETURNING pinned_at IS NOT NULL, locked_at IS NOT NULL",
        &id,
        None,
    )
    .await?;
    Ok(Json(st))
}

/// F020 `PUT /api/games/{id}/comment-settings`, checked in the API § F020 order: auth (401,
/// extractor) → malformed JSON (400, extractor) → game visible (404) → owner or admin (403) →
/// `Limit::ThreadTools` (429) → body object → `mode` → `slowModeSecs` (422). Leaves
/// `updated_at`/`last_updated_at` alone and writes no activity or notifications.
pub async fn put_comment_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> AppResult<Json<CommentSettings>> {
    let game = fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    if user.id != game.owner_id && !is_admin(&state, Some(&user.id)).await? {
        return Err(AppError::forbidden());
    }
    limit_user(&state, Limit::ThreadTools, &user.id)?;
    let settings = parse_comment_settings(&body)?;
    let done =
        sqlx::query("UPDATE games SET comment_mode = ?, comment_slow_mode_secs = ? WHERE id = ?")
            .bind(settings.mode.as_db())
            .bind(settings.slow_mode_secs)
            .bind(&game_id)
            .execute(&state.db)
            .await?
            .rows_affected();
    if done == 0 {
        return Err(AppError::not_found("Game"));
    }
    Ok(Json(settings))
}

/// F020 body validation (texts verbatim from API § F020). A missing field, a wrong JSON type and
/// an unknown value give the same message; extra fields are ignored.
fn parse_comment_settings(body: &serde_json::Value) -> AppResult<CommentSettings> {
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::validation("Body must be a JSON object"))?;
    let mode = obj
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .and_then(CommentMode::from_db)
        .ok_or_else(|| AppError::validation("mode must be one of: on, repliesOnly, off"))?;
    // `as_i64` is `None` for floats (`60.0`, `60.5`), strings, bools and null.
    let slow_mode_secs = obj
        .get("slowModeSecs")
        .and_then(serde_json::Value::as_i64)
        .filter(|s| SLOW_MODE_SECS.contains(s))
        .ok_or_else(|| {
            AppError::validation("slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600")
        })?;
    Ok(CommentSettings {
        mode,
        slow_mode_secs,
    })
}
