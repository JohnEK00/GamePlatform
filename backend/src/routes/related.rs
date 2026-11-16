//! GET /api/games/{id}/related ("More like this", F003; docs/API.md § F003).

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use sqlx::Row;

use crate::AppState;
use crate::auth::MaybeAuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::{ApiPath, ApiQuery};
use crate::models::{GAME_SELECT, GameRow, RelatedGame, game_row_from_row};
use crate::routes::games::fetch_visible_game;
use crate::trending::{self, tag_weight};

pub const DEFAULT_LIMIT: i64 = 8;
pub const MAX_LIMIT: i64 = 24;
/// At most this many results share one owner (the source's owner included).
pub const OWNER_CAP: usize = 2;
/// Candidate rows read from the tag query.
const TAG_CANDIDATES: i64 = 100;
/// Trending fill: rows per batch and maximum batches scanned.
const FILL_BATCH: i64 = 100;
const FILL_MAX_BATCHES: i64 = 10;

#[derive(Deserialize)]
pub struct RelatedQuery {
    pub limit: Option<String>,
}

fn parse_limit(v: Option<&str>) -> AppResult<i64> {
    Ok(match v.map(str::trim).filter(|s| !s.is_empty()) {
        None => DEFAULT_LIMIT,
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("limit must be an integer".into()))?,
    }
    .clamp(1, MAX_LIMIT))
}

struct Pick {
    id: String,
    reason: &'static str,
    shared: Vec<String>,
}

/// Owner cap bookkeeping: `true` (and counted) if `owner` still has room.
fn take_owner(counts: &mut HashMap<String, usize>, owner: &str) -> bool {
    let n = counts.entry(owner.to_string()).or_insert(0);
    if *n >= OWNER_CAP {
        return false;
    }
    *n += 1;
    true
}

pub async fn related_games(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<RelatedQuery>,
) -> AppResult<Json<Vec<RelatedGame>>> {
    let source = fetch_visible_game(&state, &id, viewer.id()).await?;
    let limit = parse_limit(query.limit.as_deref())? as usize;
    trending::ensure_fresh(&state).await;

    let mut picks: Vec<Pick> = Vec::new();
    let mut owners: HashMap<String, usize> = HashMap::new();

    // 1. Games sharing tags with the source, weighted by tag rarity.
    if !source.tags.is_empty() {
        let tags_json = serde_json::to_string(&source.tags)
            .map_err(|e| AppError::Internal(format!("json: {e}")))?;
        let counts: Vec<(String, i64)> = sqlx::query_as(
            "SELECT t.tag, COUNT(*) FROM game_tags t JOIN games g ON g.id = t.game_id \
             WHERE g.published = 1 AND t.tag IN (SELECT value FROM json_each(?)) \
             GROUP BY t.tag",
        )
        .bind(&tags_json)
        .fetch_all(&state.db)
        .await?;
        let n_of: HashMap<String, i64> = counts.into_iter().collect();

        let cases = vec!["WHEN ? THEN ?"; source.tags.len()].join(" ");
        let ins = vec!["?"; source.tags.len()].join(", ");
        let sql = format!(
            "SELECT t.game_id, \
                    SUM(CASE t.tag {cases} ELSE 0 END) AS tag_score, \
                    COUNT(*) AS shared, \
                    group_concat(t.tag, ',') AS shared_tags, \
                    MAX(g.owner_id) AS owner_id \
             FROM game_tags t \
             JOIN games g ON g.id = t.game_id \
             LEFT JOIN game_trending tr ON tr.game_id = g.id \
             WHERE t.tag IN ({ins}) AND t.game_id <> ? AND g.published = 1 \
             GROUP BY t.game_id \
             ORDER BY tag_score DESC, shared DESC, COALESCE(MAX(tr.score), 0) DESC, \
                      MAX(g.plays) DESC, MAX(g.created_at) DESC, t.game_id \
             LIMIT ?"
        );
        let mut q = sqlx::query(&sql);
        for tag in &source.tags {
            let n = n_of.get(tag).copied().unwrap_or(0);
            q = q.bind(tag).bind(tag_weight(n));
        }
        for tag in &source.tags {
            q = q.bind(tag);
        }
        let rows = q
            .bind(&source.id)
            .bind(TAG_CANDIDATES)
            .fetch_all(&state.db)
            .await?;
        for row in &rows {
            if picks.len() >= limit {
                break;
            }
            let owner: String = row.try_get("owner_id")?;
            if !take_owner(&mut owners, &owner) {
                continue;
            }
            let csv: Option<String> = row.try_get("shared_tags")?;
            let theirs: Vec<&str> = csv.as_deref().unwrap_or("").split(',').collect();
            let shared = source
                .tags
                .iter()
                .filter(|t| theirs.contains(&t.as_str()))
                .cloned()
                .collect();
            picks.push(Pick {
                id: row.try_get("game_id")?,
                reason: "tags",
                shared,
            });
        }
    }

    // 2. Fill up in `sort=trending` order.
    let mut batch = 0;
    while picks.len() < limit && batch < FILL_MAX_BATCHES {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT g.id, g.owner_id FROM games g \
             LEFT JOIN game_trending tr ON tr.game_id = g.id \
             WHERE g.published = 1 AND g.id <> ? \
             ORDER BY COALESCE(tr.score, 0) DESC, COALESCE(tr.plays_week, 0) DESC, \
                      g.plays DESC, g.created_at DESC, g.id \
             LIMIT ? OFFSET ?",
        )
        .bind(&source.id)
        .bind(FILL_BATCH)
        .bind(batch * FILL_BATCH)
        .fetch_all(&state.db)
        .await?;
        let exhausted = (rows.len() as i64) < FILL_BATCH;
        for (gid, owner) in rows {
            if picks.len() >= limit {
                break;
            }
            if picks.iter().any(|p| p.id == gid) || !take_owner(&mut owners, &owner) {
                continue;
            }
            picks.push(Pick {
                id: gid,
                reason: "trending",
                shared: Vec::new(),
            });
        }
        if exhausted {
            break;
        }
        batch += 1;
    }

    if picks.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // 3. Summaries in one query, in the computed order.
    let ids: Vec<&str> = picks.iter().map(|p| p.id.as_str()).collect();
    let ids_json =
        serde_json::to_string(&ids).map_err(|e| AppError::Internal(format!("json: {e}")))?;
    let rows = sqlx::query(&format!(
        "{GAME_SELECT} WHERE g.id IN (SELECT value FROM json_each(?)) AND g.published = 1"
    ))
    .bind(ids_json)
    .fetch_all(&state.db)
    .await?;
    let mut games: HashMap<String, GameRow> = rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| (g.id.clone(), g)))
        .collect::<Result<_, _>>()?;
    let items = picks
        .into_iter()
        .filter_map(|p| {
            games.remove(&p.id).map(|g| RelatedGame {
                summary: g.summary(),
                reason: p.reason,
                shared_tags: p.shared,
            })
        })
        .collect();
    Ok(Json(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_parsing() {
        assert_eq!(parse_limit(None).unwrap(), 8);
        assert_eq!(parse_limit(Some("")).unwrap(), 8);
        assert_eq!(parse_limit(Some("0")).unwrap(), 1);
        assert_eq!(parse_limit(Some("99")).unwrap(), 24);
        assert_eq!(parse_limit(Some(" 5 ")).unwrap(), 5);
        assert!(parse_limit(Some("x")).is_err());
        assert!(parse_limit(Some("2.5")).is_err());
    }

    #[test]
    fn owner_cap() {
        let mut m = HashMap::new();
        assert!(take_owner(&mut m, "a"));
        assert!(take_owner(&mut m, "a"));
        assert!(!take_owner(&mut m, "a"));
        assert!(take_owner(&mut m, "b"));
    }
}
