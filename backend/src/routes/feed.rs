//! F002 activity feed: GET /api/feed and GET /api/feed/suggestions (fan-out on read).

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::AppState;
use crate::activity::{KIND_ACHIEVEMENT, KIND_PERSONAL_BEST, KINDS};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::models::{
    AchievementDef, GAME_SELECT, GameRow, GameSummary, LeaderboardConfig, UserRef,
    achievement_icon_url, game_row_from_row, user_ref_from_row,
};
use crate::ratelimit::Limit;
use crate::routes::games::limit_user;

pub const FEED_LIMIT_DEFAULT: i64 = 20;
pub const FEED_LIMIT_MAX: i64 = 50;
pub const SUGGESTIONS_MAX: i64 = 6;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedScore {
    pub value: i64,
    pub first: bool,
    pub leaderboard: LeaderboardConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedAchievement {
    #[serde(flatten)]
    pub def: AchievementDef,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    pub kind: String,
    pub actor: UserRef,
    pub game: GameSummary,
    pub reason: &'static str,
    pub created_at: String,
    pub version: Option<i64>,
    pub score: Option<FeedScore>,
    pub achievement: Option<FeedAchievement>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub items: Vec<FeedItem>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct FeedQuery {
    pub cursor: Option<String>,
    pub limit: Option<String>,
    pub kinds: Option<String>,
}

fn nonempty(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

/// `cursor`: absent/blank → none; otherwise a decimal positive i64, else 400.
pub fn parse_cursor(v: Option<&str>) -> AppResult<Option<i64>> {
    let Some(s) = nonempty(v) else {
        return Ok(None);
    };
    let bad = || AppError::BadRequest("cursor must be a positive integer".into());
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    match s.parse::<i64>() {
        Ok(n) if n > 0 => Ok(Some(n)),
        _ => Err(bad()),
    }
}

/// `limit`: default 20, clamped to 1-50; non-integer → 400.
pub fn parse_feed_limit(v: Option<&str>) -> AppResult<i64> {
    Ok(match nonempty(v) {
        None => FEED_LIMIT_DEFAULT,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?,
    }
    .clamp(1, FEED_LIMIT_MAX))
}

/// `kinds`: comma list of feed kinds (blank entries ignored); empty → all; unknown → 400.
pub fn parse_kinds(v: Option<&str>) -> AppResult<Vec<&'static str>> {
    let mut out: Vec<&'static str> = Vec::new();
    for part in v.unwrap_or("").split(',').map(str::trim) {
        if part.is_empty() {
            continue;
        }
        let kind = KINDS
            .iter()
            .find(|k| **k == part)
            .ok_or_else(|| AppError::BadRequest(format!("Unknown feed kind '{part}'")))?;
        if !out.contains(kind) {
            out.push(kind);
        }
    }
    if out.is_empty() {
        out.extend(KINDS);
    }
    Ok(out)
}

fn json_list<T: Serialize>(v: &[T]) -> AppResult<String> {
    serde_json::to_string(v).map_err(|e| AppError::Internal(format!("json: {e}")))
}

/// GET /api/feed?cursor=&limit=&kinds= (🔒, `Limit::Feed`).
pub async fn get_feed(
    State(state): State<AppState>,
    user: AuthUser,
    ApiQuery(query): ApiQuery<FeedQuery>,
) -> AppResult<Json<FeedPage>> {
    limit_user(&state, Limit::Feed, &user.id)?;
    let cursor = parse_cursor(query.cursor.as_deref())?;
    let limit = parse_feed_limit(query.limit.as_deref())?;
    let kinds = parse_kinds(query.kinds.as_deref())?;

    let rows = sqlx::query(
        "SELECT e.id, e.kind, e.game_id, e.version, e.score, e.first_score, e.ach_id, \
           e.ach_count, e.created_at, \
           (e.actor_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1)) AS followed, \
           a.name AS a_name, a.description AS a_description, a.icon AS a_icon, \
           u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
           u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
         FROM activity_events e \
         JOIN games g ON g.id = e.game_id \
         JOIN users u ON u.id = e.actor_id \
         LEFT JOIN achievements a ON a.game_id = e.game_id AND a.ach_id = e.ach_id \
         WHERE (e.actor_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1) \
                OR (e.kind IN ('gamePublished','gameUpdated') \
                    AND e.game_id IN (SELECT game_id FROM favorites WHERE user_id = ?1))) \
           AND e.actor_id <> ?1 \
           AND g.published = 1 \
           AND (e.kind <> 'achievementUnlocked' OR a.ach_id IS NOT NULL) \
           AND (?2 IS NULL OR e.id < ?2) \
           AND e.kind IN (SELECT value FROM json_each(?4)) \
         ORDER BY e.id DESC LIMIT ?3",
    )
    .bind(&user.id)
    .bind(cursor)
    .bind(limit + 1)
    .bind(json_list(&kinds)?)
    .fetch_all(&state.db)
    .await?;

    let has_more = rows.len() as i64 > limit;
    let rows = &rows[..rows.len().min(limit as usize)];

    // Games of this page in one query.
    let mut game_ids: Vec<String> = Vec::new();
    for r in rows {
        let gid: String = r.try_get("game_id")?;
        if !game_ids.contains(&gid) {
            game_ids.push(gid);
        }
    }
    let game_rows = sqlx::query(&format!(
        "{GAME_SELECT} WHERE g.id IN (SELECT value FROM json_each(?))"
    ))
    .bind(json_list(&game_ids)?)
    .fetch_all(&state.db)
    .await?;
    let games: HashMap<String, GameRow> = game_rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| (g.id.clone(), g)))
        .collect::<Result<_, _>>()?;

    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let game_id: String = r.try_get("game_id")?;
        let Some(game) = games.get(&game_id) else {
            continue; // deleted between the two queries
        };
        let kind: String = r.try_get("kind")?;
        let id: i64 = r.try_get("id")?;
        let followed: i64 = r.try_get("followed")?;
        let score = if kind == KIND_PERSONAL_BEST {
            Some(FeedScore {
                value: r.try_get::<Option<i64>, _>("score")?.unwrap_or(0),
                first: r.try_get::<i64, _>("first_score")? != 0,
                leaderboard: game.leaderboard.clone(),
            })
        } else {
            None
        };
        let achievement = if kind == KIND_ACHIEVEMENT {
            let icon: Option<String> = r.try_get("a_icon")?;
            Some(FeedAchievement {
                def: AchievementDef {
                    id: r
                        .try_get::<Option<String>, _>("ach_id")?
                        .unwrap_or_default(),
                    name: r
                        .try_get::<Option<String>, _>("a_name")?
                        .unwrap_or_default(),
                    description: r
                        .try_get::<Option<String>, _>("a_description")?
                        .unwrap_or_default(),
                    icon_url: achievement_icon_url(&game_id, icon.as_deref()),
                },
                count: r.try_get::<i64, _>("ach_count")?.max(1),
            })
        } else {
            None
        };
        items.push(FeedItem {
            id: id.to_string(),
            actor: user_ref_from_row(r, "u_")?,
            game: game.summary(),
            reason: if followed != 0 {
                "following"
            } else {
                "favorite"
            },
            created_at: r.try_get("created_at")?,
            version: match kind.as_str() {
                "gamePublished" | "gameUpdated" => r.try_get("version")?,
                _ => None,
            },
            score,
            achievement,
            kind,
        });
    }
    // The cursor is the last *row* of this page, so a row skipped above never stalls paging.
    let next_cursor = if has_more {
        rows.last()
            .map(|r| r.try_get::<i64, _>("id"))
            .transpose()?
            .map(|id| id.to_string())
    } else {
        None
    };
    Ok(Json(FeedPage { items, next_cursor }))
}

#[derive(Serialize)]
pub struct SuggestedCreator {
    pub user: UserRef,
    pub reason: &'static str,
    pub games: i64,
}

const SUGGEST_USER_COLS: &str = "u.id AS u_id, u.username AS u_username, \
     u.display_name AS u_display_name, u.avatar_ext AS u_avatar_ext, \
     u.avatar_version AS u_avatar_version, \
     (SELECT COUNT(*) FROM games pg WHERE pg.owner_id = u.id AND pg.published = 1) AS n_games";

/// GET /api/feed/suggestions (🔒, `Limit::Feed`): up to 6 creators to follow.
/// 1. Owners of published games the viewer favorited (by number of such favorites, then most
///    recent favorite). 2. Filled up with owners by total plays of their published games.
///    Never the viewer, users already followed, or users without a published game.
pub async fn get_suggestions(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<SuggestedCreator>>> {
    limit_user(&state, Limit::Feed, &user.id)?;
    let mut out: Vec<SuggestedCreator> = Vec::new();

    let favored = sqlx::query(&format!(
        "SELECT {SUGGEST_USER_COLS} FROM ( \
           SELECT g.owner_id, COUNT(*) AS n, MAX(f.created_at) AS last, MAX(f.rowid) AS last_rid \
           FROM favorites f JOIN games g ON g.id = f.game_id \
           WHERE f.user_id = ?1 AND g.published = 1 AND g.owner_id <> ?1 \
             AND g.owner_id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?1) \
           GROUP BY g.owner_id \
         ) fo JOIN users u ON u.id = fo.owner_id \
         ORDER BY fo.n DESC, fo.last DESC, fo.last_rid DESC LIMIT ?2"
    ))
    .bind(&user.id)
    .bind(SUGGESTIONS_MAX)
    .fetch_all(&state.db)
    .await?;
    for r in &favored {
        out.push(SuggestedCreator {
            user: user_ref_from_row(r, "u_")?,
            reason: "favorited",
            games: r.try_get("n_games")?,
        });
    }

    let missing = SUGGESTIONS_MAX - out.len() as i64;
    if missing > 0 {
        let picked: Vec<&str> = out.iter().map(|s| s.user.id.as_str()).collect();
        let popular = sqlx::query(&format!(
            "SELECT {SUGGEST_USER_COLS} FROM ( \
               SELECT g.owner_id, SUM(g.plays) AS plays FROM games g \
               WHERE g.published = 1 AND g.owner_id <> ?1 \
                 AND g.owner_id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?1) \
                 AND g.owner_id NOT IN (SELECT value FROM json_each(?2)) \
               GROUP BY g.owner_id \
             ) po JOIN users u ON u.id = po.owner_id \
             ORDER BY po.plays DESC, u.username_lower ASC LIMIT ?3"
        ))
        .bind(&user.id)
        .bind(json_list(&picked)?)
        .bind(missing)
        .fetch_all(&state.db)
        .await?;
        for r in &popular {
            out.push(SuggestedCreator {
                user: user_ref_from_row(r, "u_")?,
                reason: "popular",
                games: r.try_get("n_games")?,
            });
        }
    }
    Ok(Json(out))
}
