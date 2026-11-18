//! F008 collections (docs/API.md § F008 additions, docs/ARCHITECTURE.md § F008 additions):
//! `POST /api/collections`, `GET`/`PATCH`/`DELETE /api/collections/{id}`,
//! `PUT`/`DELETE /api/collections/{id}/games/{gameId}`, `PUT /api/collections/{id}/order`,
//! `GET /api/users/{username}/collections`, `GET /api/users/me/collections` and
//! `GET /api/games/{id}/collections`.
//!
//! Check order for writes on `/api/collections/{id}…`: auth (401) → collection visible to the
//! caller (404) → owner, or owner/admin for DELETE (403) → `Limit::Collections` (429) → body
//! (400/422) → the endpoint's own rules. Bodies are therefore read as raw bytes and parsed
//! only after the earlier checks. Writes that check a cap run under `BEGIN IMMEDIATE`, and
//! every successful change bumps `collections.updated_at` in the same transaction.
//!
//! F021: an add of a published game to a public collection (`PUT …/games/{gameId}` with
//! `added: true`, or `POST` with `gameId`) writes a `collectionUpdated` activity event inside
//! the add transaction and, after the commit, an `addedToCollection` notification to the game's
//! owner. Removing the game withdraws that notification while unread. No other collection
//! write produces activity.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};

use crate::AppState;
use crate::activity;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiPath, ApiQuery};
use crate::models::{
    Collection, CollectionItem, CollectionItemResponse, CollectionRemoveResponse,
    CollectionSummary, GAME_SELECT, GameCollectionsPage, MyCollection, Page, UserRef,
    game_row_from_row, now_rfc3339, thumbnail_url, user_ref_from_row,
};
use crate::notifications::{self as notif, Dedupe, Kind, NewNotification};
use crate::ratelimit::Limit;
use crate::routes::games::{fetch_visible_game, limit_user, page_offset, parse_paging};
use crate::routes::screenshots::is_admin;
use crate::versions::is_bidi_control;

pub const TITLE_MAX: usize = 60;
pub const DESCRIPTION_MAX: usize = 500;
pub const DESCRIPTION_LINES_MAX: usize = 8;
pub const NOTE_MAX: usize = 140;
pub const COLLECTIONS_PER_USER_MAX: i64 = 50;
pub const GAMES_PER_COLLECTION_MAX: i64 = 100;
pub const COVERS_MAX: usize = 4;
pub const USER_LIST_PER_PAGE_DEFAULT: i64 = 24;
pub const SHELF_LIMIT_DEFAULT: i64 = 6;
pub const SHELF_LIMIT_MAX: i64 = 24;

const NOT_FOUND: &str = "Collection";

// ---------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------

fn not_plain(c: char) -> bool {
    c.is_control() || is_bidi_control(c)
}

/// Trimmed; 1–60 scalar values; no control or bidi-control characters.
pub fn validate_collection_title(raw: &str) -> AppResult<String> {
    let text = raw.trim();
    let n = text.chars().count();
    if n == 0 || n > TITLE_MAX {
        return Err(AppError::validation("title must be 1–60 characters"));
    }
    if text.chars().any(not_plain) {
        return Err(AppError::validation(
            "title must be a single line of plain text",
        ));
    }
    Ok(text.to_string())
}

/// `\r\n`/`\r` → `\n`, trimmed; 0–500 scalar values; at most 8 lines; no other control
/// characters (including `\t`) and no bidi controls.
pub fn validate_collection_description(raw: &str) -> AppResult<String> {
    let normalised = raw.replace("\r\n", "\n").replace('\r', "\n");
    let text = normalised.trim();
    if text.chars().count() > DESCRIPTION_MAX {
        return Err(AppError::validation(
            "description must be at most 500 characters",
        ));
    }
    if text.matches('\n').count() > DESCRIPTION_LINES_MAX - 1 {
        return Err(AppError::validation("description must be at most 8 lines"));
    }
    if text.chars().any(|c| c != '\n' && not_plain(c)) {
        return Err(AppError::validation("description must be plain text"));
    }
    Ok(text.to_string())
}

/// Trimmed; 0–140 scalar values; no control characters (including `\n`), no bidi controls
/// (the screenshot caption rules with the "note" wording).
pub fn validate_collection_note(raw: &str) -> AppResult<String> {
    let text = raw.trim();
    if text.chars().count() > NOTE_MAX {
        return Err(AppError::validation("note must be at most 140 characters"));
    }
    if text.chars().any(not_plain) {
        return Err(AppError::validation(
            "note must be a single line of plain text",
        ));
    }
    Ok(text.to_string())
}

/// Exactly `"public"` or `"private"` (any other value or JSON type → 422).
pub fn parse_visibility(v: &Value) -> AppResult<&'static str> {
    match v.as_str() {
        Some("public") => Ok("public"),
        Some("private") => Ok("private"),
        _ => Err(AppError::validation(
            "visibility must be \"public\" or \"private\"",
        )),
    }
}

/// A JSON object body. Malformed JSON → 400; any other JSON value → 422. With `optional`, an
/// empty body (or `null`) is an empty object.
fn parse_object(body: &Bytes, optional: bool) -> AppResult<Map<String, Value>> {
    if optional && body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    let v: Value = serde_json::from_slice(body)
        .map_err(|_| AppError::BadRequest("Request body must be valid JSON".into()))?;
    match v {
        Value::Object(m) => Ok(m),
        Value::Null if optional => Ok(Map::new()),
        _ => Err(AppError::validation("Request body must be a JSON object")),
    }
}

/// An optional string field: absent or `null` → `None`; another JSON type → 422.
fn opt_str<'a>(m: &'a Map<String, Value>, name: &str) -> AppResult<Option<&'a str>> {
    match m.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(AppError::validation(format!("{name} must be a string"))),
    }
}

fn opt_visibility(m: &Map<String, Value>) -> AppResult<Option<&'static str>> {
    match m.get("visibility") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => parse_visibility(v).map(Some),
    }
}

// ---------------------------------------------------------------------------
// Rows and visibility
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CollectionRow {
    pub id: String,
    pub owner_id: String,
    pub title: String,
    pub description: String,
    pub visibility: String,
    pub created_at: String,
    pub updated_at: String,
    pub owner: UserRef,
}

impl CollectionRow {
    /// Public → anyone; private → its owner or an admin.
    pub fn visible_to(&self, viewer: Option<&str>, is_admin: bool) -> bool {
        self.visibility == "public" || is_admin || viewer == Some(self.owner_id.as_str())
    }

    fn summary(&self, game_count: i64, cover_urls: Vec<String>) -> CollectionSummary {
        CollectionSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            visibility: self.visibility.clone(),
            owner: self.owner.clone(),
            game_count,
            cover_urls,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            path: format!("/c/{}", self.id),
        }
    }
}

/// Collection columns + owner (`o_` prefix). Append `WHERE …`.
const COLLECTION_SELECT: &str = "SELECT c.id, c.owner_id, c.title, c.description, \
     c.visibility, c.created_at, c.updated_at, \
     u.id AS o_id, u.username AS o_username, u.display_name AS o_display_name, \
     u.avatar_ext AS o_avatar_ext, u.avatar_version AS o_avatar_version \
     FROM collections c JOIN users u ON u.id = c.owner_id";

fn collection_from_row(row: &SqliteRow) -> Result<CollectionRow, sqlx::Error> {
    Ok(CollectionRow {
        id: row.try_get("id")?,
        owner_id: row.try_get("owner_id")?,
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        visibility: row.try_get("visibility")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        owner: user_ref_from_row(row, "o_")?,
    })
}

fn collections_from_rows(rows: &[SqliteRow]) -> AppResult<Vec<CollectionRow>> {
    Ok(rows
        .iter()
        .map(collection_from_row)
        .collect::<Result<Vec<_>, _>>()?)
}

/// The collection if it exists and is visible to the viewer, else 404 "Collection not found".
pub async fn load_collection(
    state: &AppState,
    id: &str,
    viewer: Option<&str>,
    is_admin: bool,
) -> AppResult<CollectionRow> {
    let row = sqlx::query(&format!("{COLLECTION_SELECT} WHERE c.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    match row.as_ref().map(collection_from_row).transpose()? {
        Some(c) if c.visible_to(viewer, is_admin) => Ok(c),
        _ => Err(AppError::not_found(NOT_FOUND)),
    }
}

/// Steps 2–4 of the write check order: visible (404) → owner, or admin when `allow_admin`
/// (403) → `Limit::Collections` (429). Returns the row and whether the caller is an admin.
async fn load_for_write(
    state: &AppState,
    id: &str,
    user_id: &str,
    allow_admin: bool,
) -> AppResult<(CollectionRow, bool)> {
    let admin = is_admin(state, Some(user_id)).await?;
    let row = load_collection(state, id, Some(user_id), admin).await?;
    if row.owner_id != user_id && !(allow_admin && admin) {
        return Err(AppError::forbidden());
    }
    limit_user(state, Limit::Collections, user_id)?;
    Ok((row, admin))
}

/// Inside a write transaction: the collection still exists (a concurrent delete → 404).
async fn ensure_exists(conn: &mut SqliteConnection, id: &str) -> AppResult<()> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM collections WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found(NOT_FOUND))
}

async fn bump(conn: &mut SqliteConnection, id: &str, now: &str) -> AppResult<()> {
    sqlx::query("UPDATE collections SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Inside a write transaction: the game is visible to `user_id` (`GET /api/games/{id}` rule),
/// else 404 "Game not found".
async fn ensure_game_visible(
    conn: &mut SqliteConnection,
    game_id: &str,
    user_id: &str,
) -> AppResult<()> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM games WHERE id = ? AND (published = 1 OR owner_id = ?)")
            .bind(game_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    found.map(|_| ()).ok_or_else(|| AppError::not_found("Game"))
}

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

/// Summaries for a page of collections: one batched query for every collection's visible
/// items (ARCHITECTURE § F008), aggregated into `gameCount` and the first 4 `coverUrls`.
pub async fn summaries_for(
    state: &AppState,
    rows: &[CollectionRow],
    viewer: Option<&str>,
) -> AppResult<Vec<CollectionSummary>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; rows.len()].join(", ");
    let sql = format!(
        "SELECT cg.collection_id, g.id, g.thumbnail_ext, g.thumbnail_version \
         FROM collection_games cg JOIN games g ON g.id = cg.game_id \
         WHERE cg.collection_id IN ({placeholders}) AND (g.published = 1 OR g.owner_id = ?) \
         ORDER BY cg.collection_id, cg.position, cg.added_at, cg.game_id"
    );
    let mut q = sqlx::query_as::<_, (String, String, Option<String>, i64)>(&sql);
    for r in rows {
        q = q.bind(&r.id);
    }
    let items = q.bind(viewer).fetch_all(&state.db).await?;
    let mut agg: HashMap<String, (i64, Vec<String>)> = HashMap::new();
    for (cid, gid, ext, ver) in items {
        let e = agg.entry(cid).or_default();
        e.0 += 1;
        if e.1.len() < COVERS_MAX
            && let Some(url) = thumbnail_url(&gid, ext.as_deref(), ver)
        {
            e.1.push(url);
        }
    }
    Ok(rows
        .iter()
        .map(|r| {
            let (count, covers) = agg.remove(&r.id).unwrap_or_default();
            r.summary(count, covers)
        })
        .collect())
}

/// The collection's items for the viewer, in collection order: visible games with their
/// summary; invisible ones as `game: null` for the owner, omitted for everyone else.
async fn load_items(
    state: &AppState,
    c: &CollectionRow,
    viewer: Option<&str>,
) -> AppResult<Vec<CollectionItem>> {
    let sql = GAME_SELECT
        .replacen(
            "SELECT ",
            "SELECT cg.game_id AS cg_game_id, cg.note AS cg_note, cg.added_at AS cg_added_at, ",
            1,
        )
        .replacen(
            "FROM games g JOIN users u ON u.id = g.owner_id",
            "FROM collection_games cg JOIN games g ON g.id = cg.game_id \
             JOIN users u ON u.id = g.owner_id",
            1,
        );
    let rows = sqlx::query(&format!(
        "{sql} WHERE cg.collection_id = ? ORDER BY cg.position, cg.added_at, cg.game_id"
    ))
    .bind(&c.id)
    .fetch_all(&state.db)
    .await?;
    let is_owner = viewer == Some(c.owner_id.as_str());
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let game = game_row_from_row(row)?;
        let visible = game.visible_to(viewer);
        if !visible && !is_owner {
            continue;
        }
        items.push(CollectionItem {
            game_id: row.try_get("cg_game_id")?,
            game: visible.then(|| game.summary()),
            note: row.try_get("cg_note")?,
            added_at: row.try_get("cg_added_at")?,
        });
    }
    Ok(items)
}

/// The full `Collection` for the viewer (`gameCount`/`coverUrls` from the same item rows).
pub async fn build_collection(
    state: &AppState,
    c: &CollectionRow,
    viewer: Option<&str>,
    is_admin: bool,
) -> AppResult<Collection> {
    let items = load_items(state, c, viewer).await?;
    let visible: Vec<_> = items.iter().filter_map(|i| i.game.as_ref()).collect();
    let covers = visible
        .iter()
        .filter_map(|g| g.thumbnail_url.clone())
        .take(COVERS_MAX)
        .collect();
    let is_owner = viewer == Some(c.owner_id.as_str());
    Ok(Collection {
        summary: c.summary(visible.len() as i64, covers),
        items,
        is_owner,
        can_delete: is_owner || (viewer.is_some() && is_admin),
    })
}

/// F021: called in the add transaction right after the guarded item insert. When the
/// collection is public and the game published (read in the same transaction, so a concurrent
/// PATCH to private can't slip in between), records the `collectionUpdated` event and returns
/// the game's owner for the notification sent after the commit; otherwise writes nothing.
async fn announce_add(
    conn: &mut SqliteConnection,
    actor_id: &str,
    collection_id: &str,
    game_id: &str,
    now: &str,
) -> AppResult<Option<String>> {
    let row: Option<(String, bool, String)> = sqlx::query_as(
        "SELECT c.visibility, g.published, g.owner_id FROM collections c, games g \
         WHERE c.id = ?1 AND g.id = ?2",
    )
    .bind(collection_id)
    .bind(game_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some((visibility, true, owner_id)) if visibility == "public" => {
            activity::record_collection_added(conn, actor_id, collection_id, game_id, now).await;
            Ok(Some(owner_id))
        }
        _ => Ok(None),
    }
}

/// F021: the `addedToCollection` notification after an announced add commits (best effort;
/// skipped for the curator's own game).
async fn notify_added(
    state: &AppState,
    actor_id: &str,
    collection_id: &str,
    game_id: &str,
    owner_id: &str,
) {
    if owner_id == actor_id {
        return;
    }
    let n = NewNotification {
        recipient_id: owner_id.to_string(),
        kind: Kind::AddedToCollection,
        group_key: notif::collection_group(collection_id, game_id),
        game_id: Some(game_id.to_string()),
        comment_id: None,
        actor_id: actor_id.to_string(),
        event_comment_id: None,
        event_screenshot_id: None,
        dedupe: Dedupe::Group,
        thread_id: None,
        collection_id: Some(collection_id.to_string()),
        now: chrono::Utc::now(),
    };
    notif::notify_pool(&state.db, &n).await;
}

/// Delete a collection (items cascade) and resolve every open report on it with resolution
/// `delete`, in one transaction. A missing collection is a no-op. Shared by
/// `DELETE /api/collections/{id}` and the admin resolve `delete` action.
pub async fn remove_collection(state: &AppState, id: &str) -> AppResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ? \
         WHERE target_type = 'collection' AND target_id = ? AND status = 'open'",
    )
    .bind(now_rfc3339())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM collections WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers: single collection
// ---------------------------------------------------------------------------

/// `POST /api/collections`: auth → 429 → body (422) → `gameId` visible (404) → cap (422).
pub async fn create_collection(
    State(state): State<AppState>,
    user: AuthUser,
    body: Bytes,
) -> AppResult<(StatusCode, Json<Collection>)> {
    limit_user(&state, Limit::Collections, &user.id)?;
    let body = parse_object(&body, false)?;
    let title = match body.get("title") {
        None | Some(Value::Null) => {
            return Err(AppError::validation("title must be 1–60 characters"));
        }
        Some(Value::String(s)) => validate_collection_title(s)?,
        Some(_) => return Err(AppError::validation("title must be a string")),
    };
    let description = opt_str(&body, "description")?
        .map(validate_collection_description)
        .transpose()?
        .unwrap_or_default();
    let visibility = opt_visibility(&body)?.unwrap_or("public");
    let game_id = opt_str(&body, "gameId")?.map(str::to_string);

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(gid) = &game_id {
        ensure_game_visible(&mut tx, gid, &user.id).await?;
    }
    let inserted = sqlx::query(
        "INSERT INTO collections (id, owner_id, title, description, visibility, created_at, \
         updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 \
         WHERE (SELECT COUNT(*) FROM collections WHERE owner_id = ?2) < ?7",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(&title)
    .bind(&description)
    .bind(visibility)
    .bind(&now)
    .bind(COLLECTIONS_PER_USER_MAX)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(AppError::validation(format!(
            "You can have at most {COLLECTIONS_PER_USER_MAX} collections"
        )));
    }
    let mut announced: Option<String> = None;
    if let Some(gid) = &game_id {
        sqlx::query(
            "INSERT INTO collection_games (collection_id, game_id, position, note, added_at) \
             VALUES (?, ?, 0, '', ?)",
        )
        .bind(&id)
        .bind(gid)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        announced = announce_add(&mut tx, &user.id, &id, gid, &now).await?;
    }
    tx.commit().await?;
    if let (Some(gid), Some(owner)) = (&game_id, &announced) {
        notify_added(&state, &user.id, &id, gid, owner).await;
    }

    let row = load_collection(&state, &id, Some(&user.id), true).await?;
    let c = build_collection(&state, &row, Some(&user.id), false).await?;
    Ok((StatusCode::CREATED, Json(c)))
}

/// `GET /api/collections/{id}`
pub async fn get_collection(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Collection>> {
    let admin = is_admin(&state, viewer.id()).await?;
    let row = load_collection(&state, &id, viewer.id(), admin).await?;
    Ok(Json(
        build_collection(&state, &row, viewer.id(), admin).await?,
    ))
}

/// `PATCH /api/collections/{id}` (owner only; admins who aren't the owner → 403).
pub async fn update_collection(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    body: Bytes,
) -> AppResult<Json<Collection>> {
    let (row, admin) = load_for_write(&state, &id, &user.id, false).await?;
    let body = parse_object(&body, false)?;
    let title = opt_str(&body, "title")?
        .map(validate_collection_title)
        .transpose()?;
    let description = opt_str(&body, "description")?
        .map(validate_collection_description)
        .transpose()?;
    let visibility = opt_visibility(&body)?;

    let new_title = title.unwrap_or_else(|| row.title.clone());
    let new_description = description.unwrap_or_else(|| row.description.clone());
    let new_visibility = visibility.unwrap_or(row.visibility.as_str()).to_string();
    let changed = new_title != row.title
        || new_description != row.description
        || new_visibility != row.visibility;
    if changed {
        sqlx::query(
            "UPDATE collections SET title = ?, description = ?, visibility = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(&new_title)
        .bind(&new_description)
        .bind(&new_visibility)
        .bind(now_rfc3339())
        .bind(&id)
        .execute(&state.db)
        .await?;
    }
    let row = load_collection(&state, &id, Some(&user.id), true).await?;
    Ok(Json(
        build_collection(&state, &row, Some(&user.id), admin).await?,
    ))
}

/// `DELETE /api/collections/{id}` (owner or admin).
pub async fn delete_collection(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    load_for_write(&state, &id, &user.id, true).await?;
    remove_collection(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The owner's view of the collection after a change (for the item responses).
async fn owner_view(state: &AppState, id: &str, owner: &str) -> AppResult<Collection> {
    let row = load_collection(state, id, Some(owner), true).await?;
    build_collection(state, &row, Some(owner), false).await
}

/// `PUT /api/collections/{id}/games/{gameId}`: add (append) or update the note.
pub async fn put_collection_game(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath((id, game_id)): ApiPath<(String, String)>,
    body: Bytes,
) -> AppResult<Json<CollectionItemResponse>> {
    load_for_write(&state, &id, &user.id, false).await?;
    let body = parse_object(&body, true)?;
    let note = opt_str(&body, "note")?
        .map(validate_collection_note)
        .transpose()?;

    let now = now_rfc3339();
    let mut announced: Option<String> = None;
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    ensure_exists(&mut tx, &id).await?;
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT note FROM collection_games WHERE collection_id = ? AND game_id = ?",
    )
    .bind(&id)
    .bind(&game_id)
    .fetch_optional(&mut *tx)
    .await?;
    let added = match existing {
        Some(old) => {
            // Already present: works even when the game is no longer visible, and at the cap.
            if let Some(n) = note.as_deref()
                && n != old
            {
                sqlx::query(
                    "UPDATE collection_games SET note = ? WHERE collection_id = ? AND game_id = ?",
                )
                .bind(n)
                .bind(&id)
                .bind(&game_id)
                .execute(&mut *tx)
                .await?;
                bump(&mut tx, &id, &now).await?;
            }
            false
        }
        None => {
            ensure_game_visible(&mut tx, &game_id, &user.id).await?;
            let inserted = sqlx::query(
                "INSERT INTO collection_games (collection_id, game_id, position, note, added_at) \
                 SELECT ?1, ?2, COALESCE((SELECT MAX(position) FROM collection_games \
                 WHERE collection_id = ?1), -1) + 1, ?3, ?4 \
                 WHERE (SELECT COUNT(*) FROM collection_games WHERE collection_id = ?1) < ?5",
            )
            .bind(&id)
            .bind(&game_id)
            .bind(note.as_deref().unwrap_or(""))
            .bind(&now)
            .bind(GAMES_PER_COLLECTION_MAX)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if inserted == 0 {
                return Err(AppError::validation(format!(
                    "A collection can hold at most {GAMES_PER_COLLECTION_MAX} games"
                )));
            }
            bump(&mut tx, &id, &now).await?;
            announced = announce_add(&mut tx, &user.id, &id, &game_id, &now).await?;
            true
        }
    };
    tx.commit().await?;
    if let Some(owner) = &announced {
        notify_added(&state, &user.id, &id, &game_id, owner).await;
    }

    let c = owner_view(&state, &id, &user.id).await?;
    let item = c
        .items
        .iter()
        .find(|i| i.game_id == game_id)
        .cloned()
        // Only if a concurrent request removed it again right after the commit.
        .ok_or_else(|| AppError::not_found("Game"))?;
    Ok(Json(CollectionItemResponse {
        added,
        item,
        game_count: c.summary.game_count,
        updated_at: c.summary.updated_at,
    }))
}

/// `DELETE /api/collections/{id}/games/{gameId}` (idempotent).
pub async fn delete_collection_game(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath((id, game_id)): ApiPath<(String, String)>,
) -> AppResult<Json<CollectionRemoveResponse>> {
    load_for_write(&state, &id, &user.id, false).await?;
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let removed =
        sqlx::query("DELETE FROM collection_games WHERE collection_id = ? AND game_id = ?")
            .bind(&id)
            .bind(&game_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
    if removed {
        bump(&mut tx, &id, &now_rfc3339()).await?;
    }
    tx.commit().await?;
    if removed {
        // F021: withdraw the owner's unread `addedToCollection` (best effort). A deleted game
        // needs nothing: its notifications cascaded.
        let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM games WHERE id = ?")
            .bind(&game_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "failed to look up the game owner for a withdrawal");
                None
            });
        if let Some(owner) = owner {
            notif::withdraw_pool(
                &state.db,
                &owner,
                Kind::AddedToCollection,
                &notif::collection_group(&id, &game_id),
            )
            .await;
        }
    }
    let c = owner_view(&state, &id, &user.id).await?;
    Ok(Json(CollectionRemoveResponse {
        removed,
        game_count: c.summary.game_count,
        updated_at: c.summary.updated_at,
    }))
}

/// `PUT /api/collections/{id}/order`: the full new order of all items.
pub async fn put_collection_order(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    body: Bytes,
) -> AppResult<Json<Collection>> {
    let (_, admin) = load_for_write(&state, &id, &user.id, false).await?;
    let body = parse_object(&body, false)?;
    let bad_shape = || AppError::validation("gameIds must be an array of strings");
    let ids: Vec<String> = match body.get("gameIds") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| v.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(bad_shape)?,
        _ => return Err(bad_shape()),
    };
    if ids.len() as i64 > GAMES_PER_COLLECTION_MAX {
        return Err(AppError::validation(format!(
            "gameIds must have at most {GAMES_PER_COLLECTION_MAX} entries"
        )));
    }
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if wanted.len() != ids.len() {
        return Err(AppError::validation("gameIds must not contain duplicates"));
    }

    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    ensure_exists(&mut tx, &id).await?;
    let current: Vec<String> = sqlx::query_scalar(
        "SELECT game_id FROM collection_games WHERE collection_id = ? \
         ORDER BY position, added_at, game_id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    let same_set =
        current.len() == ids.len() && current.iter().all(|g| wanted.contains(g.as_str()));
    if !same_set {
        return Err(AppError::Conflict(
            "The collection has changed; reload and try again".into(),
        ));
    }
    if current != ids {
        let order =
            serde_json::to_string(&ids).map_err(|e| AppError::Internal(format!("json: {e}")))?;
        sqlx::query(
            "UPDATE collection_games SET position = (SELECT CAST(j.key AS INTEGER) \
             FROM json_each(?2) j WHERE j.value = collection_games.game_id) \
             WHERE collection_id = ?1",
        )
        .bind(&id)
        .bind(&order)
        .execute(&mut *tx)
        .await?;
        bump(&mut tx, &id, &now_rfc3339()).await?;
    }
    tx.commit().await?;

    let row = load_collection(&state, &id, Some(&user.id), true).await?;
    Ok(Json(
        build_collection(&state, &row, Some(&user.id), admin).await?,
    ))
}

// ---------------------------------------------------------------------------
// Handlers: lists
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCollectionsQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

/// The visibility filter of [`list_user_collections`] (alias `c`; binds `?1` owner id, `?2`
/// viewer id or NULL, `?3` is_self). F028: the profile `stats.collections` count reuses it.
pub(crate) const USER_COLLECTIONS_FILTER: &str = "c.owner_id = ?1 AND (?3 = 1 OR (c.visibility = 'public' AND EXISTS ( \
     SELECT 1 FROM collection_games cg JOIN games g ON g.id = cg.game_id \
     WHERE cg.collection_id = c.id AND (g.published = 1 OR g.owner_id = ?2))))";

/// `GET /api/users/{username}/collections`: the user themself sees all their collections;
/// everyone else sees public ones with at least one game visible to them.
pub async fn list_user_collections(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<UserCollectionsQuery>,
) -> AppResult<Json<Page<CollectionSummary>>> {
    let (page, per_page) = parse_paging(
        query.page.as_deref(),
        query.per_page.as_deref(),
        USER_LIST_PER_PAGE_DEFAULT,
    )?;
    let owner: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username_lower = ?")
        .bind(username.to_lowercase())
        .fetch_optional(&state.db)
        .await?;
    let owner = owner.ok_or_else(|| AppError::not_found("User"))?;
    let is_self = viewer.id() == Some(owner.as_str());
    let filter = USER_COLLECTIONS_FILTER;
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM collections c WHERE {filter}"
    ))
    .bind(&owner)
    .bind(viewer.id())
    .bind(is_self)
    .fetch_one(&state.db)
    .await?;
    let rows = sqlx::query(&format!(
        "{COLLECTION_SELECT} WHERE {filter} ORDER BY c.updated_at DESC, c.id DESC \
         LIMIT ?4 OFFSET ?5"
    ))
    .bind(&owner)
    .bind(viewer.id())
    .bind(is_self)
    .bind(per_page)
    .bind(page_offset(page, per_page))
    .fetch_all(&state.db)
    .await?;
    let rows = collections_from_rows(&rows)?;
    Ok(Json(Page {
        items: summaries_for(&state, &rows, viewer.id()).await?,
        total,
        page,
        per_page,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MyCollectionsQuery {
    pub game_id: Option<String>,
}

/// `GET /api/users/me/collections?gameId=`: all of the caller's collections (max 50).
pub async fn list_my_collections(
    State(state): State<AppState>,
    user: AuthUser,
    ApiQuery(query): ApiQuery<MyCollectionsQuery>,
) -> AppResult<Json<Vec<MyCollection>>> {
    let rows = sqlx::query(&format!(
        "{COLLECTION_SELECT} WHERE c.owner_id = ? ORDER BY c.updated_at DESC, c.id DESC"
    ))
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?;
    let rows = collections_from_rows(&rows)?;
    let summaries = summaries_for(&state, &rows, Some(&user.id)).await?;

    let counts: HashMap<String, i64> = sqlx::query_as::<_, (String, i64)>(
        "SELECT cg.collection_id, COUNT(*) FROM collection_games cg \
         JOIN collections c ON c.id = cg.collection_id WHERE c.owner_id = ? \
         GROUP BY cg.collection_id",
    )
    .bind(&user.id)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .collect();

    let game_id = query
        .game_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut containing: HashSet<String> = HashSet::new();
    if let Some(gid) = game_id {
        match fetch_visible_game(&state, gid, Some(&user.id)).await {
            Ok(_) => {
                containing = sqlx::query_scalar::<_, String>(
                    "SELECT cg.collection_id FROM collection_games cg \
                     JOIN collections c ON c.id = cg.collection_id \
                     WHERE cg.game_id = ? AND c.owner_id = ?",
                )
                .bind(gid)
                .bind(&user.id)
                .fetch_all(&state.db)
                .await?
                .into_iter()
                .collect();
            }
            Err(AppError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }

    Ok(Json(
        summaries
            .into_iter()
            .map(|s| MyCollection {
                contains_game: containing.contains(&s.id),
                item_count: counts.get(&s.id).copied().unwrap_or(0),
                summary: s,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct GameCollectionsQuery {
    pub limit: Option<String>,
}

/// `GET /api/games/{id}/collections?limit=`: public collections containing a visible game.
pub async fn list_game_collections(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<GameCollectionsQuery>,
) -> AppResult<Json<GameCollectionsPage>> {
    let limit = match query
        .limit
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => SHELF_LIMIT_DEFAULT,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?
            .clamp(1, SHELF_LIMIT_MAX),
    };
    fetch_visible_game(&state, &id, viewer.id()).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collection_games cg JOIN collections c ON c.id = cg.collection_id \
         WHERE cg.game_id = ? AND c.visibility = 'public'",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let select = COLLECTION_SELECT.replacen(
        "FROM collections c",
        "FROM collection_games cg JOIN collections c ON c.id = cg.collection_id",
        1,
    );
    let rows = sqlx::query(&format!(
        "{select} WHERE cg.game_id = ? AND c.visibility = 'public' \
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?"
    ))
    .bind(&id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let rows = collections_from_rows(&rows)?;
    Ok(Json(GameCollectionsPage {
        items: summaries_for(&state, &rows, viewer.id()).await?,
        total,
    }))
}
