//! F002 activity feed: GET /api/feed and GET /api/feed/suggestions (fan-out on read).

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::AppState;
use crate::activity::{
    KIND_ACHIEVEMENT, KIND_COLLECTION_UPDATED, KIND_GAME_UPDATED, KIND_PERSONAL_BEST,
    KIND_POST_CREATED, KIND_SCREENSHOT_POSTED, KINDS,
};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::models::{
    AchievementDef, FeedCollection, FeedCollectionGame, GAME_SELECT, GameRow, GameSummary,
    LeaderboardConfig, UserRef, achievement_icon_url, game_row_from_row, user_ref_from_row,
};
use crate::ratelimit::Limit;
use crate::routes::games::limit_user;
use crate::routes::posts::{POST_SELECT, Post, posts_for};
use crate::routes::screenshots::{
    FEED_SCREENSHOTS_SQL, Screenshot, Viewer, is_admin, screenshot_from_row,
};

pub const FEED_LIMIT_DEFAULT: i64 = 20;
pub const FEED_LIMIT_MAX: i64 = 50;
pub const SUGGESTIONS_MAX: i64 = 6;
/// F004: at most this many notes per `gameUpdated` item.
pub const FEED_CHANGES_MAX: usize = 3;
/// F021: at most this many games per `collectionUpdated` item (`gameCount` counts all).
pub const FEED_COLLECTION_GAMES_MAX: usize = 4;
/// F015: at most this many screenshots per `screenshotPosted` item (`count` counts all).
pub const FEED_SCREENSHOTS_MAX: usize = 4;

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

/// F004 `FeedUpdate.changes[]`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedChange {
    pub version: i64,
    pub notes: String,
}

/// F004 `FeedUpdate`: the versions covered by a (possibly coalesced) `gameUpdated` item.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedUpdate {
    pub from_version: i64,
    pub changes: Vec<FeedChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    pub kind: String,
    pub actor: UserRef,
    /// F030: `None` for `postCreated` only (its attachment is in `post`).
    pub game: Option<GameSummary>,
    pub reason: &'static str,
    pub created_at: String,
    pub version: Option<i64>,
    pub score: Option<FeedScore>,
    pub achievement: Option<FeedAchievement>,
    /// F004: non-null for `gameUpdated` only.
    pub update: Option<FeedUpdate>,
    /// F021: non-null for `collectionUpdated` only.
    pub collection: Option<FeedCollection>,
    /// F015: non-null for `screenshotPosted` only.
    pub screenshots: Option<FeedScreenshots>,
    /// F030: non-null for `postCreated` only.
    pub post: Option<Post>,
}

/// F015 `FeedScreenshots`: the actor's screenshots of the game on the item's UTC day.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedScreenshots {
    pub count: i64,
    pub items: Vec<Screenshot>,
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

/// Feed page query (N1). Three index-driven branches, each yielding at most `limit + 1` ids
/// (`?3`) newest first with every filter applied inside the branch:
///   (a) followed creators: `follows` PK → `idx_activity_actor_id (actor_id, id DESC)`;
///       F015 `screenshotPosted` rows additionally probe `idx_screenshots_author_game
///       (author_id, game_id)` (at most 20 rows per pair) for a shot still on the row's day;
///   (b) favorited games' publish/update events: `idx_favorites_user_game` →
///       `idx_activity_game_kind (game_id, kind, id DESC)`;
///   (c) F021 followed curators' `collectionUpdated` events: `follows` PK →
///       `idx_activity_actor_id`, then primary-key probes of `collections` (public, still the
///       actor's) and an `EXISTS` over the row's `game_ids` (still in the collection, added
///       that day, published). Branch (a) drops these rows through its `games` join.
///   (d) F030 followed users' `postCreated` events: `follows` PK → `idx_activity_actor_id`,
///       joining nothing else (the post's FK cascade guarantees it exists). Branches (a) and
///       (c) never pick these rows (`game_id` and `collection_id` are NULL).
/// `CROSS JOIN` fixes the join order and `INDEXED BY` the indices, so the plan never depends
/// on planner statistics. In (c) the unary `+` on `c.visibility` and `c.owner_id` keeps the
/// collections probe on the primary key (F032's `idx_collections_public_updated` otherwise
/// tipped it onto `idx_collections_owner_updated`). The union is de-duplicated by id and the outer query only joins the
/// at most `4 · (limit + 1)` picked rows. The work grows with the activity of the creators the
/// viewer follows and the games they favorited (before the cursor), never with total platform
/// activity. `tests/review2.rs` asserts the plan.
/// Binds: ?1 viewer id, ?2 cursor (exclusive, nullable), ?3 limit + 1, ?4 kinds JSON list.
pub const FEED_SQL: &str = "\
    WITH picked(id) AS ( \
      SELECT id FROM ( \
        SELECT e.id FROM follows f \
        CROSS JOIN activity_events e INDEXED BY idx_activity_actor_id \
        CROSS JOIN games g \
        WHERE f.follower_id = ?1 AND e.actor_id = f.followee_id \
          AND e.id < COALESCE(?2, 9223372036854775807) \
          AND e.actor_id <> ?1 \
          AND e.kind IN (SELECT value FROM json_each(?4)) \
          AND g.id = e.game_id AND g.published = 1 \
          AND (e.kind <> 'achievementUnlocked' OR EXISTS ( \
                SELECT 1 FROM achievements a \
                WHERE a.game_id = e.game_id AND a.ach_id = e.ach_id)) \
          AND (e.kind <> 'screenshotPosted' OR EXISTS ( \
                SELECT 1 FROM screenshots s INDEXED BY idx_screenshots_author_game \
                WHERE s.author_id = e.actor_id AND s.game_id = e.game_id \
                  AND substr(s.created_at, 1, 10) = e.day)) \
        ORDER BY e.id DESC LIMIT ?3) \
      UNION \
      SELECT id FROM ( \
        SELECT e.id FROM favorites fv INDEXED BY idx_favorites_user_game \
        CROSS JOIN activity_events e INDEXED BY idx_activity_game_kind \
        CROSS JOIN games g \
        WHERE fv.user_id = ?1 AND e.game_id = fv.game_id \
          AND e.kind IN ('gamePublished', 'gameUpdated') \
          AND e.id < COALESCE(?2, 9223372036854775807) \
          AND e.actor_id <> ?1 \
          AND e.kind IN (SELECT value FROM json_each(?4)) \
          AND g.id = e.game_id AND g.published = 1 \
        ORDER BY e.id DESC LIMIT ?3) \
      UNION \
      SELECT id FROM ( \
        SELECT e.id FROM follows f \
        CROSS JOIN activity_events e INDEXED BY idx_activity_actor_id \
        CROSS JOIN collections c \
        WHERE f.follower_id = ?1 AND e.actor_id = f.followee_id \
          AND e.id < COALESCE(?2, 9223372036854775807) \
          AND e.actor_id <> ?1 \
          AND e.kind = 'collectionUpdated' \
          AND e.kind IN (SELECT value FROM json_each(?4)) \
          AND c.id = e.collection_id AND +c.visibility = 'public' AND +c.owner_id = e.actor_id \
          AND EXISTS (SELECT 1 FROM json_each(e.game_ids) j \
                      JOIN collection_games cg ON cg.collection_id = e.collection_id \
                        AND cg.game_id = j.value \
                      JOIN games g2 ON g2.id = cg.game_id \
                      WHERE substr(cg.added_at, 1, 10) = e.day AND g2.published = 1) \
        ORDER BY e.id DESC LIMIT ?3) \
      UNION \
      SELECT id FROM ( \
        SELECT e.id FROM follows f \
        CROSS JOIN activity_events e INDEXED BY idx_activity_actor_id \
        WHERE f.follower_id = ?1 AND e.actor_id = f.followee_id \
          AND e.id < COALESCE(?2, 9223372036854775807) \
          AND e.actor_id <> ?1 \
          AND e.kind = 'postCreated' \
          AND e.kind IN (SELECT value FROM json_each(?4)) \
          AND e.post_id IS NOT NULL \
        ORDER BY e.id DESC LIMIT ?3) \
    ) \
    SELECT e.id, e.kind, e.game_id, e.version, e.score, e.first_score, e.ach_id, \
      e.ach_count, e.created_at, COALESCE(e.from_version, e.version) AS from_version, \
      e.collection_id, e.game_ids, e.day, e.post_id, \
      EXISTS (SELECT 1 FROM follows f \
              WHERE f.follower_id = ?1 AND f.followee_id = e.actor_id) AS followed, \
      a.name AS a_name, a.description AS a_description, a.icon AS a_icon, \
      u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
      u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
    FROM picked p \
    CROSS JOIN activity_events e ON e.id = p.id \
    CROSS JOIN users u ON u.id = e.actor_id \
    LEFT JOIN achievements a ON a.game_id = e.game_id AND a.ach_id = e.ach_id \
    ORDER BY e.id DESC LIMIT ?3";

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

    let rows = sqlx::query(FEED_SQL)
        .bind(&user.id)
        .bind(cursor)
        .bind(limit + 1)
        .bind(json_list(&kinds)?)
        .fetch_all(&state.db)
        .await?;

    let has_more = rows.len() as i64 > limit;
    let rows = &rows[..rows.len().min(limit as usize)];

    // F021: the announced game ids of each `collectionUpdated` row (by row id) and the page's
    // collections.
    let mut announced: HashMap<i64, Vec<String>> = HashMap::new();
    let mut collection_ids: Vec<String> = Vec::new();
    for r in rows {
        let kind: String = r.try_get("kind")?;
        if kind != KIND_COLLECTION_UPDATED {
            continue;
        }
        let id: i64 = r.try_get("id")?;
        let raw: Option<String> = r.try_get("game_ids")?;
        let ids: Vec<String> = raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        announced.insert(id, ids);
        if let Some(cid) = r.try_get::<Option<String>, _>("collection_id")?
            && !collection_ids.contains(&cid)
        {
            collection_ids.push(cid);
        }
    }

    // Games of this page in one query (F021: including every announced game).
    let mut game_ids: Vec<String> = Vec::new();
    for r in rows {
        if let Some(gid) = r.try_get::<Option<String>, _>("game_id")?
            && !game_ids.contains(&gid)
        {
            game_ids.push(gid);
        }
    }
    for ids in announced.values() {
        for gid in ids {
            if !game_ids.contains(gid) {
                game_ids.push(gid.clone());
            }
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

    // F021: the page's public collections and their items (two batched queries).
    let mut collections: HashMap<String, String> = HashMap::new();
    let mut items_of: HashMap<(String, String), (String, String)> = HashMap::new();
    if !collection_ids.is_empty() {
        let cj = json_list(&collection_ids)?;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, title FROM collections \
             WHERE id IN (SELECT value FROM json_each(?)) AND visibility = 'public'",
        )
        .bind(&cj)
        .fetch_all(&state.db)
        .await?;
        collections.extend(rows);
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT collection_id, game_id, note, added_at FROM collection_games \
             WHERE collection_id IN (SELECT value FROM json_each(?))",
        )
        .bind(&cj)
        .fetch_all(&state.db)
        .await?;
        for (cid, gid, note, added_at) in rows {
            items_of.insert((cid, gid), (note, added_at));
        }
    }

    // F004: non-empty notes of this page's updated games in one query; sliced per item below.
    let mut updated_ids: Vec<String> = Vec::new();
    for r in rows {
        let kind: String = r.try_get("kind")?;
        if kind != KIND_GAME_UPDATED {
            continue;
        }
        if let Some(gid) = r.try_get::<Option<String>, _>("game_id")?
            && !updated_ids.contains(&gid)
        {
            updated_ids.push(gid);
        }
    }
    let mut notes_by_game: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    if !updated_ids.is_empty() {
        let note_rows: Vec<(String, i64, String)> = sqlx::query_as(
            "SELECT game_id, version, notes FROM game_versions \
             WHERE game_id IN (SELECT value FROM json_each(?)) AND notes <> '' \
             ORDER BY version DESC",
        )
        .bind(json_list(&updated_ids)?)
        .fetch_all(&state.db)
        .await?;
        for (gid, version, notes) in note_rows {
            notes_by_game.entry(gid).or_default().push((version, notes));
        }
    }

    // F015: the screenshots of this page's `screenshotPosted` rows in one query, grouped by
    // `[actorId, gameId, day]` in query order (newest first within a group).
    let mut shot_keys: Vec<[String; 3]> = Vec::new();
    for r in rows {
        let kind: String = r.try_get("kind")?;
        if kind != KIND_SCREENSHOT_POSTED {
            continue;
        }
        let Some(gid) = r.try_get::<Option<String>, _>("game_id")? else {
            continue;
        };
        let key = [r.try_get("u_id")?, gid, r.try_get("day")?];
        if !shot_keys.contains(&key) {
            shot_keys.push(key);
        }
    }
    let mut shots_of: HashMap<[String; 3], (i64, Vec<Screenshot>)> = HashMap::new();
    if !shot_keys.is_empty() {
        let viewer = Viewer {
            id: Some(&user.id),
            admin: is_admin(&state, Some(&user.id)).await?,
        };
        let shot_rows = sqlx::query(FEED_SCREENSHOTS_SQL)
            .bind(json_list(&shot_keys)?)
            .fetch_all(&state.db)
            .await?;
        for sr in &shot_rows {
            let key = [
                sr.try_get("p_actor")?,
                sr.try_get("p_game")?,
                sr.try_get("p_day")?,
            ];
            let group = shots_of.entry(key).or_default();
            group.0 += 1;
            if group.1.len() < FEED_SCREENSHOTS_MAX {
                group.1.push(screenshot_from_row(sr, &viewer)?);
            }
        }
    }

    // F030: the page's posts in one query, assembled for the viewer.
    let mut post_ids: Vec<String> = Vec::new();
    for r in rows {
        let kind: String = r.try_get("kind")?;
        if kind != KIND_POST_CREATED {
            continue;
        }
        if let Some(pid) = r.try_get::<Option<String>, _>("post_id")?
            && !post_ids.contains(&pid)
        {
            post_ids.push(pid);
        }
    }
    let mut posts: HashMap<String, Post> = HashMap::new();
    if !post_ids.is_empty() {
        let post_rows = sqlx::query(&format!(
            "{POST_SELECT} WHERE p.id IN (SELECT value FROM json_each(?))"
        ))
        .bind(json_list(&post_ids)?)
        .fetch_all(&state.db)
        .await?;
        for p in posts_for(&state, &post_rows, Some(&user.id)).await? {
            posts.insert(p.id.clone(), p);
        }
    }

    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let kind: String = r.try_get("kind")?;
        let id: i64 = r.try_get("id")?;
        if kind == KIND_POST_CREATED {
            let Some(post) = r
                .try_get::<Option<String>, _>("post_id")?
                .and_then(|pid| posts.remove(&pid))
            else {
                continue; // deleted since the page query
            };
            items.push(FeedItem {
                id: id.to_string(),
                actor: user_ref_from_row(r, "u_")?,
                game: None,
                reason: "following",
                created_at: post.created_at.clone(),
                version: None,
                score: None,
                achievement: None,
                update: None,
                collection: None,
                screenshots: None,
                post: Some(post),
                kind,
            });
            continue;
        }
        let mut screenshots = None;
        if kind == KIND_SCREENSHOT_POSTED {
            let key: [String; 3] = [
                r.try_get("u_id")?,
                r.try_get::<Option<String>, _>("game_id")?
                    .unwrap_or_default(),
                r.try_get("day")?,
            ];
            let Some((count, shots)) = shots_of.remove(&key) else {
                continue; // every shot of that day was deleted since the page query
            };
            screenshots = Some(FeedScreenshots {
                count,
                items: shots,
            });
        }
        let followed: i64 = r.try_get("followed")?;
        let mut collection = None;
        let (game_id, game) = if kind == KIND_COLLECTION_UPDATED {
            // F021 "Games of an item": announced, still in the collection, added on the
            // item's day, published; newest add first (the array order).
            let Some(cid) = r.try_get::<Option<String>, _>("collection_id")? else {
                continue;
            };
            let Some(title) = collections.get(&cid) else {
                continue; // deleted or made private since the page query
            };
            let day: String = r.try_get("day")?;
            let kept: Vec<(&GameRow, &String)> = announced
                .get(&id)
                .into_iter()
                .flatten()
                .filter_map(|gid| {
                    let (note, added_at) = items_of.get(&(cid.clone(), gid.clone()))?;
                    let game = games.get(gid).filter(|g| g.published)?;
                    (added_at.get(..10) == Some(day.as_str())).then_some((game, note))
                })
                .collect();
            let Some((first, _)) = kept.first() else {
                continue;
            };
            let first = *first;
            collection = Some(FeedCollection {
                path: format!("/c/{cid}"),
                id: cid,
                title: title.clone(),
                game_count: kept.len() as i64,
                games: kept
                    .iter()
                    .take(FEED_COLLECTION_GAMES_MAX)
                    .map(|(g, note)| FeedCollectionGame {
                        game: g.summary(),
                        note: (*note).clone(),
                    })
                    .collect(),
            });
            (first.id.clone(), first)
        } else {
            let Some(game_id) = r.try_get::<Option<String>, _>("game_id")? else {
                continue;
            };
            let Some(game) = games.get(&game_id) else {
                continue; // deleted between the two queries
            };
            (game_id, game)
        };
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
        let update = if kind == KIND_GAME_UPDATED {
            let version: i64 = r.try_get::<Option<i64>, _>("version")?.unwrap_or(0);
            let from_version: i64 = r
                .try_get::<Option<i64>, _>("from_version")?
                .unwrap_or(version);
            let changes = notes_by_game
                .get(&game_id)
                .map(|vs| {
                    vs.iter()
                        .filter(|(v, _)| (from_version..=version).contains(v))
                        .take(FEED_CHANGES_MAX)
                        .map(|(v, n)| FeedChange {
                            version: *v,
                            notes: n.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(FeedUpdate {
                from_version,
                changes,
            })
        } else {
            None
        };
        items.push(FeedItem {
            id: id.to_string(),
            actor: user_ref_from_row(r, "u_")?,
            game: Some(game.summary()),
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
            update,
            collection,
            screenshots,
            post: None,
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
