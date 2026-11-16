//! JSON DTOs (camelCase, matching docs/API.md) and row mapping helpers.

use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    #[serde(flatten)]
    pub user_ref: UserRef,
    pub bio: String,
    pub created_at: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub owner: UserRef,
    pub thumbnail_url: Option<String>,
    pub plays: i64,
    pub rating_avg: f64,
    pub rating_count: i64,
    pub published: bool,
    pub created_at: String,
    pub updated_at: String,
    pub favorites: i64,
    /// F003: counted non-owner plays over the last 7 UTC days (trending snapshot).
    pub plays_week: i64,
    /// F004: latest bundle replace made while the game was published; `None` if none.
    pub last_updated_at: Option<String>,
}

/// `GameVersion` (API.md § F004): one row of a game's version history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersion {
    pub version: i64,
    pub notes: String,
    pub created_at: String,
    pub current: bool,
}

/// `RelatedGame` (API.md § F003): a summary plus why it was picked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedGame {
    #[serde(flatten)]
    pub summary: GameSummary,
    /// `"tags"` or `"trending"`.
    pub reason: &'static str,
    pub shared_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementDef {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameAchievement {
    #[serde(flatten)]
    pub def: AchievementDef,
    pub unlocked_by: i64,
    pub unlocked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAchievement {
    #[serde(flatten)]
    pub def: AchievementDef,
    pub game_id: String,
    pub game_title: String,
    pub unlocked_at: String,
}

/// Server-relative URL of an achievement icon inside the current bundle.
pub fn achievement_icon_url(game_id: &str, icon: Option<&str>) -> Option<String> {
    icon.map(|i| {
        format!(
            "/games/{game_id}/files/{}",
            crate::routes::play::encode_path(i)
        )
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    #[serde(flatten)]
    pub summary: GameSummary,
    pub width: i64,
    pub height: i64,
    pub version: i64,
    pub entry: String,
    pub play_url: String,
    pub my_rating: Option<i64>,
    pub is_owner: bool,
    pub is_favorite: bool,
    pub achievements: Vec<AchievementDef>,
    pub leaderboard: LeaderboardConfig,
    /// F004: the current version's history row.
    pub latest_version: GameVersion,
    /// F009: declared actions of the current version, normalised, in manifest order.
    pub actions: Vec<ControlAction>,
    /// F009: normalised game.json `controls` (0-300 chars, `""` when none).
    pub controls_hint: String,
}

/// `ControlAction` (API.md § F009).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlAction {
    pub id: String,
    pub name: String,
    pub keys: Vec<String>,
    pub gamepad: Vec<String>,
}

/// Parse a stored `games.actions_json`. `NULL` → `[]`; unparsable → `[]` with a warning.
pub fn parse_stored_actions(game_id: &str, raw: Option<&str>) -> Vec<ControlAction> {
    let Some(raw) = raw else { return Vec::new() };
    match serde_json::from_str(raw) {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(game_id, error = %e, "unparsable games.actions_json; using []");
            Vec::new()
        }
    }
}

/// `Game.leaderboard` (API.md § F001): `{ order, format, label }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardConfig {
    pub order: String,
    pub format: String,
    pub label: String,
}

impl LeaderboardConfig {
    /// Lower scores are better.
    pub fn ascending(&self) -> bool {
        self.order == "asc"
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub game_id: String,
    pub author: UserRef,
    pub body: String,
    pub created_at: String,
    /// F006: null for top-level comments, else the id of a top-level comment.
    pub parent_id: Option<String>,
    /// F006: replies only, the author of the reply that was answered.
    pub reply_to: Option<UserRef>,
    /// F006: the author is the game's current owner.
    pub is_creator: bool,
    pub hearts: i64,
    /// F006: the viewer hearted it (false when anonymous).
    pub my_heart: bool,
    /// F006: the game's current owner hearted it.
    pub creator_heart: bool,
    /// F006: the viewer is the author, the game owner or an admin (false when anonymous).
    pub can_delete: bool,
    /// F017: top-level only, the game's pinned comment (always false on replies).
    pub pinned: bool,
    /// F017: top-level only, the thread is locked against new replies (always false on replies).
    pub locked: bool,
    /// F017: top-level only, the viewer is the game's current owner or an admin (false on
    /// replies and when anonymous).
    pub can_moderate: bool,
}

/// F006: a top-level comment with the oldest (at most 3) replies.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThread {
    #[serde(flatten)]
    pub comment: Comment,
    pub reply_count: i64,
    pub replies: Vec<Comment>,
}

/// F006: `Page<CommentThread>` + `totalAll` (comments and replies).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentListPage {
    pub items: Vec<CommentThread>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
    pub total_all: i64,
    /// F017: the game's pinned thread on every page (`null` when none; excluded from `items`
    /// and `total`).
    pub pinned: Option<CommentThread>,
}

/// F017: `PUT`/`DELETE /api/comments/{id}/pin|lock`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadState {
    pub id: String,
    pub pinned: bool,
    pub locked: bool,
    /// `PUT …/pin` only: the previously pinned comment that is now unpinned.
    pub unpinned_id: Option<String>,
}

/// F006: `GET /api/comments/{id}`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentContext {
    pub comment: Comment,
    pub thread: CommentThread,
}

/// F006: `PUT`/`DELETE /api/comments/{id}/heart`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartResponse {
    pub hearted: bool,
    pub hearts: i64,
    pub creator_heart: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub id: String,
    pub user: UserRef,
    pub score: i64,
    pub created_at: String,
    pub rank: i64,
}

#[derive(Debug, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn avatar_url(user_id: &str, ext: Option<&str>, version: i64) -> Option<String> {
    ext.map(|ext| format!("/media/avatars/{user_id}.{ext}?v={version}"))
}

pub fn thumbnail_url(game_id: &str, ext: Option<&str>, version: i64) -> Option<String> {
    ext.map(|ext| format!("/media/thumbnails/{game_id}.{ext}?v={version}"))
}

/// Columns needed for a `UserRef`, selected with the given alias prefix.
/// Expects columns `{p}id, {p}username, {p}display_name, {p}avatar_ext, {p}avatar_version`.
pub fn user_ref_from_row(row: &SqliteRow, prefix: &str) -> Result<UserRef, sqlx::Error> {
    let id: String = row.try_get(format!("{prefix}id").as_str())?;
    let ext: Option<String> = row.try_get(format!("{prefix}avatar_ext").as_str())?;
    let ver: i64 = row.try_get(format!("{prefix}avatar_version").as_str())?;
    Ok(UserRef {
        avatar_url: avatar_url(&id, ext.as_deref(), ver),
        username: row.try_get(format!("{prefix}username").as_str())?,
        display_name: row.try_get(format!("{prefix}display_name").as_str())?,
        id,
    })
}

pub const USER_COLUMNS: &str =
    "id, username, display_name, avatar_ext, avatar_version, bio, created_at, role";

pub fn user_from_row(row: &SqliteRow) -> Result<User, sqlx::Error> {
    Ok(User {
        user_ref: user_ref_from_row(row, "")?,
        bio: row.try_get("bio")?,
        created_at: row.try_get("created_at")?,
        role: row.try_get("role")?,
    })
}

/// Full game row joined with its owner and tags.
#[derive(Debug, Clone)]
pub struct GameRow {
    pub id: String,
    pub owner_id: String,
    pub title: String,
    pub description: String,
    pub published: bool,
    pub version: i64,
    pub entry: String,
    pub width: i64,
    pub height: i64,
    pub thumbnail_ext: Option<String>,
    pub thumbnail_version: i64,
    pub plays: i64,
    pub rating_sum: i64,
    pub rating_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub favorites: i64,
    pub plays_week: i64,
    pub last_updated_at: Option<String>,
    pub owner: UserRef,
    pub tags: Vec<String>,
    pub leaderboard: LeaderboardConfig,
    /// F009: raw `games.actions_json` (`None` = not yet backfilled); parsed only for `Game`
    /// and the player page, so list queries don't pay for it.
    pub actions_json: Option<String>,
    /// F009: `games.controls_hint` (`None` → `""`).
    pub controls_hint: String,
}

/// SELECT prefix for [`GameRow`]; append `WHERE ...`.
pub const GAME_SELECT: &str = "SELECT g.id, g.owner_id, g.title, g.description, g.published, \
     g.version, g.entry, g.width, g.height, g.thumbnail_ext, g.thumbnail_version, g.plays, \
     g.rating_sum, g.rating_count, g.created_at, g.updated_at, \
     g.score_order, g.score_format, g.score_label, g.last_updated_at, \
     g.actions_json, g.controls_hint, \
     u.id AS o_id, u.username AS o_username, u.display_name AS o_display_name, \
     u.avatar_ext AS o_avatar_ext, u.avatar_version AS o_avatar_version, \
     (SELECT group_concat(tag, ',') FROM (SELECT tag FROM game_tags t WHERE t.game_id = g.id \
        ORDER BY t.position, t.tag)) AS tags, \
     g.favorites_count AS favorites, \
     COALESCE((SELECT tr.plays_week FROM game_trending tr WHERE tr.game_id = g.id), 0) \
        AS plays_week \
     FROM games g JOIN users u ON u.id = g.owner_id";

pub fn game_row_from_row(row: &SqliteRow) -> Result<GameRow, sqlx::Error> {
    let tags: Option<String> = row.try_get("tags")?;
    Ok(GameRow {
        id: row.try_get("id")?,
        owner_id: row.try_get("owner_id")?,
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        published: row.try_get::<i64, _>("published")? != 0,
        version: row.try_get("version")?,
        entry: row.try_get("entry")?,
        width: row.try_get("width")?,
        height: row.try_get("height")?,
        thumbnail_ext: row.try_get("thumbnail_ext")?,
        thumbnail_version: row.try_get("thumbnail_version")?,
        plays: row.try_get("plays")?,
        rating_sum: row.try_get("rating_sum")?,
        rating_count: row.try_get("rating_count")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        favorites: row.try_get("favorites")?,
        plays_week: row.try_get("plays_week")?,
        last_updated_at: row.try_get("last_updated_at")?,
        owner: user_ref_from_row(row, "o_")?,
        tags: tags
            .map(|t| {
                t.split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        leaderboard: LeaderboardConfig {
            order: row.try_get("score_order")?,
            format: row.try_get("score_format")?,
            label: row.try_get("score_label")?,
        },
        actions_json: row.try_get("actions_json")?,
        controls_hint: row
            .try_get::<Option<String>, _>("controls_hint")?
            .unwrap_or_default(),
    })
}

pub fn rating_avg(sum: i64, count: i64) -> f64 {
    if count <= 0 {
        0.0
    } else {
        sum as f64 / count as f64
    }
}

impl GameRow {
    pub fn summary(&self) -> GameSummary {
        GameSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            tags: self.tags.clone(),
            owner: self.owner.clone(),
            thumbnail_url: thumbnail_url(
                &self.id,
                self.thumbnail_ext.as_deref(),
                self.thumbnail_version,
            ),
            plays: self.plays,
            rating_avg: rating_avg(self.rating_sum, self.rating_count),
            rating_count: self.rating_count,
            published: self.published,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            favorites: self.favorites,
            plays_week: self.plays_week,
            last_updated_at: self.last_updated_at.clone(),
        }
    }

    pub fn game(
        &self,
        my_rating: Option<i64>,
        viewer: Option<&str>,
        is_favorite: bool,
        achievements: Vec<AchievementDef>,
        latest_version: GameVersion,
    ) -> Game {
        Game {
            summary: self.summary(),
            width: self.width,
            height: self.height,
            version: self.version,
            entry: self.entry.clone(),
            play_url: format!("/play/{}", self.id),
            my_rating,
            is_owner: viewer == Some(self.owner_id.as_str()),
            is_favorite,
            achievements,
            leaderboard: self.leaderboard.clone(),
            latest_version,
            actions: self.actions(),
            controls_hint: self.controls_hint.clone(),
        }
    }

    /// F009: the stored actions (`NULL` or unparsable → `[]`).
    pub fn actions(&self) -> Vec<ControlAction> {
        parse_stored_actions(&self.id, self.actions_json.as_deref())
    }

    pub fn visible_to(&self, viewer: Option<&str>) -> bool {
        self.published || viewer == Some(self.owner_id.as_str())
    }
}

// ---------------------------------------------------------------------------
// F008 collections (docs/API.md § F008 additions)
// ---------------------------------------------------------------------------

/// `CollectionSummary`: counts and covers are evaluated for the viewer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    /// `"public"` or `"private"`.
    pub visibility: String,
    pub owner: UserRef,
    /// Items whose game is visible to the viewer.
    pub game_count: i64,
    /// Up to 4 thumbnail URLs of the first visible games that have one, in collection order.
    pub cover_urls: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    /// `"/c/{id}"` (in-app route).
    pub path: String,
}

/// `CollectionItem`: `game` is `null` (never skipped) when the game is not visible to the
/// viewer; only the collection's owner ever receives such items.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionItem {
    pub game_id: String,
    pub game: Option<GameSummary>,
    pub note: String,
    pub added_at: String,
}

/// `Collection`: a summary plus all items (max 100) and the viewer's permissions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    #[serde(flatten)]
    pub summary: CollectionSummary,
    pub items: Vec<CollectionItem>,
    pub is_owner: bool,
    pub can_delete: bool,
}

/// `MyCollection` (`GET /api/users/me/collections`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyCollection {
    #[serde(flatten)]
    pub summary: CollectionSummary,
    pub contains_game: bool,
    /// All items including unavailable ones (what the 100 cap counts).
    pub item_count: i64,
}

/// `GameCollectionsPage` (`GET /api/games/{id}/collections`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCollectionsPage {
    pub items: Vec<CollectionSummary>,
    pub total: i64,
}

/// `CollectionItemResponse` (`PUT /api/collections/{id}/games/{gameId}`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionItemResponse {
    pub added: bool,
    pub item: CollectionItem,
    pub game_count: i64,
    pub updated_at: String,
}

/// `CollectionRemoveResponse` (`DELETE /api/collections/{id}/games/{gameId}`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRemoveResponse {
    pub removed: bool,
    pub game_count: i64,
    pub updated_at: String,
}
