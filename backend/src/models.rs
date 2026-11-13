//! JSON DTOs (camelCase, matching docs/API.md) and row mapping helpers.

use serde::Serialize;
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub game_id: String,
    pub author: UserRef,
    pub body: String,
    pub created_at: String,
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
    pub owner: UserRef,
    pub tags: Vec<String>,
}

/// SELECT prefix for [`GameRow`]; append `WHERE ...`.
pub const GAME_SELECT: &str = "SELECT g.id, g.owner_id, g.title, g.description, g.published, \
     g.version, g.entry, g.width, g.height, g.thumbnail_ext, g.thumbnail_version, g.plays, \
     g.rating_sum, g.rating_count, g.created_at, g.updated_at, \
     u.id AS o_id, u.username AS o_username, u.display_name AS o_display_name, \
     u.avatar_ext AS o_avatar_ext, u.avatar_version AS o_avatar_version, \
     (SELECT group_concat(tag, ',') FROM (SELECT tag FROM game_tags t WHERE t.game_id = g.id \
        ORDER BY t.position, t.tag)) AS tags, \
     (SELECT COUNT(*) FROM favorites f WHERE f.game_id = g.id) AS favorites \
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
        owner: user_ref_from_row(row, "o_")?,
        tags: tags
            .map(|t| {
                t.split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
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
        }
    }

    pub fn game(
        &self,
        my_rating: Option<i64>,
        viewer: Option<&str>,
        is_favorite: bool,
        achievements: Vec<AchievementDef>,
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
        }
    }

    pub fn visible_to(&self, viewer: Option<&str>) -> bool {
        self.published || viewer == Some(self.owner_id.as_str())
    }
}
