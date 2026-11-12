//! /api/games/* (CRUD, bundle/thumbnail upload, plays, ratings)

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::bundle::{self, BundleMeta};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiMultipart, ApiPath, ApiQuery};
use crate::models::{
    GAME_SELECT, Game, GameRow, GameSummary, Page, game_row_from_row, now_rfc3339, rating_avg,
};
use crate::storage::validate_image;

pub const TITLE_MAX: usize = 80;
pub const DESCRIPTION_MAX: usize = 5000;
pub const TAGS_MAX: usize = 8;
pub const TAG_LEN_MAX: usize = 24;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub async fn fetch_game_row(state: &AppState, id: &str) -> AppResult<Option<GameRow>> {
    let row = sqlx::query(&format!("{GAME_SELECT} WHERE g.id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.as_ref().map(game_row_from_row).transpose()?)
}

/// The game if it exists and the viewer may see it (published or owner), else 404.
pub async fn fetch_visible_game(
    state: &AppState,
    id: &str,
    viewer: Option<&str>,
) -> AppResult<GameRow> {
    match fetch_game_row(state, id).await? {
        Some(g) if g.visible_to(viewer) => Ok(g),
        _ => Err(AppError::not_found("Game")),
    }
}

/// The game if the user owns it: 404 when invisible, 403 when visible but not owned.
pub async fn fetch_owned_game(state: &AppState, id: &str, user_id: &str) -> AppResult<GameRow> {
    let game = fetch_visible_game(state, id, Some(user_id)).await?;
    if game.owner_id != user_id {
        return Err(AppError::forbidden());
    }
    Ok(game)
}

async fn my_rating(
    state: &AppState,
    game_id: &str,
    viewer: Option<&str>,
) -> AppResult<Option<i64>> {
    let Some(uid) = viewer else { return Ok(None) };
    let r: Option<(i64,)> =
        sqlx::query_as("SELECT score FROM ratings WHERE game_id = ? AND user_id = ?")
            .bind(game_id)
            .bind(uid)
            .fetch_optional(&state.db)
            .await?;
    Ok(r.map(|(s,)| s))
}

pub async fn build_game(state: &AppState, id: &str, viewer: Option<&str>) -> AppResult<Game> {
    let row = fetch_visible_game(state, id, viewer).await?;
    let rating = my_rating(state, id, viewer).await?;
    Ok(row.game(rating, viewer))
}

pub fn validate_title(title: &str) -> AppResult<String> {
    let t = title.trim();
    let n = t.chars().count();
    if n == 0 || n > TITLE_MAX {
        return Err(AppError::validation(format!(
            "title must be 1-{TITLE_MAX} characters"
        )));
    }
    Ok(t.to_string())
}

pub fn validate_description(desc: &str) -> AppResult<String> {
    let d = desc.trim();
    if d.chars().count() > DESCRIPTION_MAX {
        return Err(AppError::validation(format!(
            "description must be at most {DESCRIPTION_MAX} characters"
        )));
    }
    Ok(d.to_string())
}

/// Trim, lowercase and de-duplicate tags; enforce count/length limits.
pub fn normalise_tags<I, S>(tags: I) -> AppResult<Vec<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = raw.as_ref().trim().to_lowercase();
        if tag.is_empty() {
            continue;
        }
        if tag.contains(',') || tag.chars().any(char::is_control) {
            return Err(AppError::validation(format!("Invalid tag: {tag}")));
        }
        if tag.chars().count() > TAG_LEN_MAX {
            return Err(AppError::validation(format!(
                "Each tag must be at most {TAG_LEN_MAX} characters"
            )));
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    if out.len() > TAGS_MAX {
        return Err(AppError::validation(format!(
            "At most {TAGS_MAX} tags are allowed"
        )));
    }
    Ok(out)
}

pub fn parse_tags_csv(csv: &str) -> AppResult<Vec<String>> {
    normalise_tags(csv.split(','))
}

fn parse_bool_field(v: &str, field: &str) -> AppResult<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(AppError::validation(format!(
            "{field} must be \"true\" or \"false\""
        ))),
    }
}

async fn replace_tags(
    tx: &mut sqlx::SqliteConnection,
    game_id: &str,
    tags: &[String],
) -> AppResult<()> {
    sqlx::query("DELETE FROM game_tags WHERE game_id = ?")
        .bind(game_id)
        .execute(&mut *tx)
        .await?;
    for (i, tag) in tags.iter().enumerate() {
        sqlx::query("INSERT INTO game_tags (game_id, tag, position) VALUES (?, ?, ?)")
            .bind(game_id)
            .bind(tag)
            .bind(i as i64)
            .execute(&mut *tx)
            .await?;
    }
    Ok(())
}

async fn extract_bundle(
    state: &AppState,
    game_id: &str,
    bytes: Vec<u8>,
) -> AppResult<(BundleMeta, std::path::PathBuf)> {
    let staging = state.storage.staging_dir(game_id);
    let dest = staging.clone();
    let meta =
        tokio::task::spawn_blocking(move || bundle::validate_and_extract(&bytes, &dest)).await??;
    Ok((meta, staging))
}

pub struct NewGame {
    /// `None` → fall back to `name` from game.json.
    pub title: Option<String>,
    pub description: String,
    pub tags: Vec<String>,
    pub published: bool,
}

/// Validate + extract a bundle and insert a new game. Returns the new game id.
pub async fn create_game_record(
    state: &AppState,
    owner_id: &str,
    new: NewGame,
    bundle_bytes: Vec<u8>,
    thumbnail: Option<(Vec<u8>, &'static str)>,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let game_dir = state.storage.game_dir(&id);
    let result: AppResult<()> = async {
        let (meta, staging) = extract_bundle(state, &id, bundle_bytes).await?;
        let title = match new.title {
            Some(t) => t,
            None => validate_title(meta.name.as_deref().unwrap_or(""))
                .map_err(|_| AppError::validation("title is required"))?,
        };
        tokio::fs::rename(&staging, state.storage.version_dir(&id, 1)).await?;

        let now = now_rfc3339();
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "INSERT INTO games (id, owner_id, title, description, published, version, entry, \
             width, height, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(owner_id)
        .bind(&title)
        .bind(&new.description)
        .bind(new.published as i64)
        .bind(&meta.entry)
        .bind(meta.width)
        .bind(meta.height)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        replace_tags(&mut tx, &id, &new.tags).await?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_dir_all(&game_dir).await;
        return Err(e);
    }

    if let Some((bytes, ext)) = thumbnail {
        save_thumbnail(state, &id, &bytes, ext).await?;
    }
    Ok(id)
}

async fn save_thumbnail(state: &AppState, game_id: &str, bytes: &[u8], ext: &str) -> AppResult<()> {
    let dir = state.storage.thumbnails_dir();
    state
        .storage
        .replace_image(&dir, game_id, ext, bytes)
        .await?;
    sqlx::query(
        "UPDATE games SET thumbnail_ext = ?, thumbnail_version = thumbnail_version + 1, \
         updated_at = ? WHERE id = ?",
    )
    .bind(ext)
    .bind(now_rfc3339())
    .bind(game_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

fn check_bundle_size(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > bundle::MAX_COMPRESSED {
        return Err(AppError::PayloadTooLarge(
            "Bundle must be at most 50MB".into(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub q: Option<String>,
    pub tag: Option<String>,
    pub owner: Option<String>,
    pub sort: Option<String>,
    pub page: Option<String>,
    pub per_page: Option<String>,
}

fn parse_int(v: Option<&str>, name: &str, default: i64) -> AppResult<i64> {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(default),
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest(format!("{name} must be an integer"))),
    }
}

pub fn parse_paging(
    page: Option<&str>,
    per_page: Option<&str>,
    default_per: i64,
) -> AppResult<(i64, i64)> {
    let page = parse_int(page, "page", 1)?.max(1);
    let per = parse_int(per_page, "perPage", default_per)?.clamp(1, 100);
    Ok((page, per))
}

fn like_pattern(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub async fn list_games(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> AppResult<Json<Page<GameSummary>>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;

    let mut conds: Vec<&str> = Vec::new();
    let mut binds: Vec<String> = Vec::new();

    match query
        .owner
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some("me") => {
            let uid = viewer.id().ok_or_else(AppError::unauthorized)?;
            conds.push("g.owner_id = ?");
            binds.push(uid.to_string());
        }
        Some(username) => {
            conds.push("g.published = 1");
            conds.push("u.username_lower = ?");
            binds.push(username.to_ascii_lowercase());
        }
        None => conds.push("g.published = 1"),
    }
    if let Some(tag) = query
        .tag
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        conds.push("EXISTS (SELECT 1 FROM game_tags t WHERE t.game_id = g.id AND t.tag = ?)");
        binds.push(tag.to_lowercase());
    }
    if let Some(q) = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        conds.push(
            "(g.title LIKE ? ESCAPE '\\' OR g.description LIKE ? ESCAPE '\\' OR EXISTS \
             (SELECT 1 FROM game_tags t WHERE t.game_id = g.id AND t.tag LIKE ? ESCAPE '\\'))",
        );
        let pat = like_pattern(q);
        binds.push(pat.clone());
        binds.push(pat.clone());
        binds.push(pat.to_lowercase());
    }

    let order = match query.sort.as_deref().map(str::trim).unwrap_or("") {
        "" | "new" => "g.created_at DESC, g.id",
        "popular" => "g.plays DESC, g.created_at DESC, g.id",
        // Bayesian-style average: pulls games with few ratings toward a prior of 3.0 (weight 2).
        "top" => {
            "((g.rating_sum + 6.0) / (g.rating_count + 2.0)) DESC, g.rating_count DESC, \
             g.created_at DESC, g.id"
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "Unknown sort '{other}' (expected new, popular or top)"
            )));
        }
    };

    let where_sql = format!("WHERE {}", conds.join(" AND "));

    let count_sql =
        format!("SELECT COUNT(*) FROM games g JOIN users u ON u.id = g.owner_id {where_sql}");
    let mut cq = sqlx::query_scalar::<_, i64>(&count_sql);
    for b in &binds {
        cq = cq.bind(b);
    }
    let total = cq.fetch_one(&state.db).await?;

    let sql = format!("{GAME_SELECT} {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    let mut q = sqlx::query(&sql);
    for b in &binds {
        q = q.bind(b);
    }
    let rows = q
        .bind(per_page)
        .bind((page - 1) * per_page)
        .fetch_all(&state.db)
        .await?;
    let items = rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| g.summary()))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

pub async fn get_game(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<Game>> {
    Ok(Json(build_game(&state, &id, viewer.id()).await?))
}

pub async fn create_game(
    State(state): State<AppState>,
    user: AuthUser,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<(StatusCode, Json<Game>)> {
    let mut title: Option<String> = None;
    let mut description = String::new();
    let mut tags = Vec::new();
    let mut published = true;
    let mut bundle_bytes: Option<Vec<u8>> = None;
    let mut thumbnail: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "title" => {
                let t = field.text().await?;
                if !t.trim().is_empty() {
                    title = Some(validate_title(&t)?);
                }
            }
            "description" => description = validate_description(&field.text().await?)?,
            "tags" => tags = parse_tags_csv(&field.text().await?)?,
            "published" => published = parse_bool_field(&field.text().await?, "published")?,
            "bundle" => {
                let b = field.bytes().await?;
                check_bundle_size(&b)?;
                bundle_bytes = Some(b.to_vec());
            }
            "thumbnail" => {
                let b = field.bytes().await?;
                if !b.is_empty() {
                    thumbnail = Some(b.to_vec());
                }
            }
            _ => {}
        }
    }

    let bundle_bytes = bundle_bytes
        .filter(|b| !b.is_empty())
        .ok_or_else(|| AppError::validation("bundle (zip) is required"))?;
    let thumbnail = match thumbnail {
        Some(b) => {
            let ext = validate_image(&b, "thumbnail")?;
            Some((b, ext))
        }
        None => None,
    };

    let new = NewGame {
        title,
        description,
        tags,
        published,
    };
    let id = create_game_record(&state, &user.id, new, bundle_bytes, thumbnail).await?;
    let game = build_game(&state, &id, Some(&user.id)).await?;
    Ok((StatusCode::CREATED, Json(game)))
}

#[derive(Deserialize)]
pub struct UpdateGameBody {
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub published: Option<bool>,
}

pub async fn update_game(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<UpdateGameBody>,
) -> AppResult<Json<Game>> {
    let game = fetch_owned_game(&state, &id, &user.id).await?;

    let title = body.title.as_deref().map(validate_title).transpose()?;
    let description = body
        .description
        .as_deref()
        .map(validate_description)
        .transpose()?;
    let tags = body.tags.map(normalise_tags).transpose()?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE games SET title = ?, description = ?, published = ?, updated_at = ? WHERE id = ?",
    )
    .bind(title.unwrap_or(game.title))
    .bind(description.unwrap_or(game.description))
    .bind(body.published.unwrap_or(game.published) as i64)
    .bind(now_rfc3339())
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if let Some(tags) = tags {
        replace_tags(&mut tx, &id, &tags).await?;
    }
    tx.commit().await?;

    Ok(Json(build_game(&state, &id, Some(&user.id)).await?))
}

pub async fn upload_bundle(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Json<Game>> {
    let game = fetch_owned_game(&state, &id, &user.id).await?;
    let mut bundle_bytes = None;
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("bundle") {
            let b = field.bytes().await?;
            check_bundle_size(&b)?;
            bundle_bytes = Some(b.to_vec());
        }
    }
    let bytes = bundle_bytes
        .filter(|b| !b.is_empty())
        .ok_or_else(|| AppError::validation("bundle (zip) is required"))?;

    let (meta, staging) = extract_bundle(&state, &id, bytes).await?;
    let old_version = game.version;
    let new_version = old_version + 1;
    let new_dir = state.storage.version_dir(&id, new_version);
    let _ = tokio::fs::remove_dir_all(&new_dir).await;
    if let Err(e) = tokio::fs::rename(&staging, &new_dir).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(e.into());
    }

    let res = sqlx::query(
        "UPDATE games SET version = ?, entry = ?, width = ?, height = ?, updated_at = ? \
         WHERE id = ? AND version = ?",
    )
    .bind(new_version)
    .bind(&meta.entry)
    .bind(meta.width)
    .bind(meta.height)
    .bind(now_rfc3339())
    .bind(&id)
    .bind(old_version)
    .execute(&state.db)
    .await;
    match res {
        Ok(r) if r.rows_affected() == 1 => {
            let _ = tokio::fs::remove_dir_all(state.storage.version_dir(&id, old_version)).await;
        }
        Ok(_) => {
            let _ = tokio::fs::remove_dir_all(&new_dir).await;
            return Err(AppError::Conflict(
                "The game was updated concurrently; please retry".into(),
            ));
        }
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&new_dir).await;
            return Err(e.into());
        }
    }

    Ok(Json(build_game(&state, &id, Some(&user.id)).await?))
}

pub async fn upload_thumbnail(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Json<Game>> {
    fetch_owned_game(&state, &id, &user.id).await?;
    let mut thumb = None;
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("thumbnail") {
            thumb = Some(field.bytes().await?);
        }
    }
    let bytes = thumb
        .filter(|b| !b.is_empty())
        .ok_or_else(|| AppError::validation("thumbnail file is required"))?;
    let ext = validate_image(&bytes, "thumbnail")?;
    save_thumbnail(&state, &id, &bytes, ext).await?;
    Ok(Json(build_game(&state, &id, Some(&user.id)).await?))
}

pub async fn delete_game(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    fetch_owned_game(&state, &id, &user.id).await?;
    sqlx::query("DELETE FROM games WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    let _ = tokio::fs::remove_dir_all(state.storage.game_dir(&id)).await;
    let thumbs = state.storage.thumbnails_dir();
    state.storage.remove_images(&thumbs, &id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct PlaysResponse {
    pub plays: i64,
}

pub async fn record_play(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<PlaysResponse>> {
    fetch_visible_game(&state, &id, viewer.id()).await?;
    let plays: i64 =
        sqlx::query_scalar("UPDATE games SET plays = plays + 1 WHERE id = ? RETURNING plays")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::not_found("Game"))?;
    Ok(Json(PlaysResponse { plays }))
}

#[derive(Deserialize)]
pub struct RatingBody {
    pub score: f64,
}

async fn rating_response(
    state: &AppState,
    game_id: &str,
    user_id: &str,
) -> AppResult<Json<serde_json::Value>> {
    let row = sqlx::query(
        "UPDATE games SET \
           rating_sum = (SELECT COALESCE(SUM(score), 0) FROM ratings WHERE game_id = ?1), \
           rating_count = (SELECT COUNT(*) FROM ratings WHERE game_id = ?1) \
         WHERE id = ?1 RETURNING rating_sum, rating_count",
    )
    .bind(game_id)
    .fetch_one(&state.db)
    .await?;
    let sum: i64 = row.try_get("rating_sum")?;
    let count: i64 = row.try_get("rating_count")?;
    let mine = my_rating(state, game_id, Some(user_id)).await?;
    Ok(Json(json!({
        "ratingAvg": rating_avg(sum, count),
        "ratingCount": count,
        "myRating": mine,
    })))
}

pub async fn put_rating(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<RatingBody>,
) -> AppResult<Json<serde_json::Value>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    let s = body.score;
    if !s.is_finite() || s.fract() != 0.0 || !(1.0..=5.0).contains(&s) {
        return Err(AppError::validation("score must be an integer from 1 to 5"));
    }
    let now = now_rfc3339();
    sqlx::query(
        "INSERT INTO ratings (user_id, game_id, score, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (user_id, game_id) DO UPDATE SET score = excluded.score, \
         updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&id)
    .bind(s as i64)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;
    rating_response(&state, &id, &user.id).await
}

pub async fn delete_rating(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<serde_json::Value>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    sqlx::query("DELETE FROM ratings WHERE user_id = ? AND game_id = ?")
        .bind(&user.id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    rating_response(&state, &id, &user.id).await
}

// ---------------------------------------------------------------------------
// Preview token
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTokenResponse {
    pub token: String,
    pub expires_at: String,
}

/// POST /api/games/{id}/preview-token (owner only): short-lived token for `/play/{id}?token=`.
pub async fn preview_token(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<PreviewTokenResponse>> {
    let game = fetch_owned_game(&state, &id, &user.id).await?;
    let (token, exp) =
        crate::auth::create_preview_token(&state.config.jwt_secret, &user.id, &game.id)?;
    let expires_at = chrono::DateTime::from_timestamp(exp, 0)
        .ok_or_else(|| AppError::Internal("preview token expiry out of range".into()))?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(Json(PreviewTokenResponse { token, expires_at }))
}
