//! F035: Explore creators (`GET /api/creators`, docs/API.md § F035 additions; SQL in
//! docs/ARCHITECTURE.md § F035 additions).
//!
//! A creator is a user with at least one published game. The list is public and the same for
//! every viewer apart from `isFollowing`; there is no rate limit (like `GET /api/games`).
//!
//! F032 adds `GET /api/creators/spotlight`. Review 12 M1: both endpoints read the periodic
//! [`crate::creators_snapshot`] instead of aggregating every published game per request.

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::MaybeAuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::models::{GAME_SELECT, GameSummary, Page, UserRef, game_row_from_row};
use crate::routes::games::{page_offset, parse_paging};
use crate::{AppState, creators_snapshot};

/// Default `perPage`.
pub const CREATORS_PER_PAGE_DEFAULT: i64 = 24;
/// Largest `perPage`; larger values are clamped to it.
pub const CREATORS_PER_PAGE_MAX: i64 = 48;
/// `bioExcerpt` length in code points (SQLite `substr` on TEXT counts characters).
pub const BIO_EXCERPT_CHARS: i64 = 160;

/// The `isFollowing` batch: one statement per page, driven by the `follows` primary key
/// `(follower_id, followee_id)`. `?1` = viewer id, `?2` = JSON array of the page's user ids.
pub const IS_FOLLOWING_SQL: &str = "SELECT followee_id FROM follows \
     WHERE follower_id = ?1 AND followee_id IN (SELECT value FROM json_each(?2))";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub user: UserRef,
    pub banner_url: Option<String>,
    pub bio_excerpt: String,
    pub games: i64,
    pub plays: i64,
    pub followers: i64,
    pub is_following: bool,
    pub first_published_at: String,
    pub last_active_at: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreatorsQuery {
    pub sort: Option<String>,
    pub page: Option<String>,
    pub per_page: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreatorSort {
    Popular,
    Active,
    New,
}

impl CreatorSort {
    /// Absent or empty → `popular`; anything else unknown → 400 `bad_request`.
    pub fn parse(raw: Option<&str>) -> AppResult<Self> {
        match raw {
            None | Some("") | Some("popular") => Ok(Self::Popular),
            Some("active") => Ok(Self::Active),
            Some("new") => Ok(Self::New),
            Some(other) => Err(AppError::BadRequest(format!(
                "Unknown sort '{}' (expected popular, active or new)",
                // Bound the echoed value, as comments.rs does.
                other.chars().take(40).collect::<String>()
            ))),
        }
    }
}
// The three orders (popular: followers DESC, plays DESC, username_lower; active: last_act
// DESC, username_lower; new: first_pub DESC, username_lower) are applied in memory by
// `CreatorsSnapshot::from_rows` (review 12 M1).

/// The creator rows (ARCHITECTURE § F035 / § F032). `{order}` is a fixed string chosen in Rust
/// (never input); `?1` = limit (`-1` = all), `?2` = offset, and with `owner_filter` `?3` = the
/// one owner id to compute. Review 12 M1: requests no longer run this; the
/// [`crate::creators_snapshot`] refresh does (`creator_sql(false, "u.id ASC")`, no limit).
pub fn creator_sql(owner_filter: bool, order: &str) -> String {
    let owner = if owner_filter {
        " AND owner_id = ?3"
    } else {
        ""
    };
    format!(
        "WITH c AS ( \
           SELECT owner_id, \
                  COUNT(*) AS games, \
                  COALESCE(SUM(plays), 0) AS plays, \
                  MIN(COALESCE(first_published_at, created_at)) AS first_pub, \
                  MAX(MAX(COALESCE(first_published_at, created_at), \
                          COALESCE(last_updated_at, ''))) AS last_act \
           FROM games WHERE published = 1{owner} GROUP BY owner_id \
         ) \
         SELECT u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
                u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version, \
                u.username_lower AS u_username_lower, \
                u.banner_ext, u.banner_version, \
                substr(u.bio, 1, {BIO_EXCERPT_CHARS}) AS bio_excerpt, \
                c.games, c.plays, c.first_pub, c.last_act, \
                (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers \
         FROM c JOIN users u ON u.id = c.owner_id \
         ORDER BY {order} \
         LIMIT ?1 OFFSET ?2"
    )
}

/// Sets `is_following` on `items` for a signed-in viewer: one [`IS_FOLLOWING_SQL`] query for
/// the page's ids (none when anonymous or the page is empty). Never true for yourself, since
/// a user can't follow themselves.
async fn apply_is_following(
    state: &AppState,
    viewer: Option<&str>,
    items: &mut [Creator],
) -> AppResult<()> {
    let Some(viewer_id) = viewer else {
        return Ok(());
    };
    if items.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = items.iter().map(|c| c.user.id.as_str()).collect();
    let ids_json =
        serde_json::to_string(&ids).map_err(|e| AppError::Internal(format!("json: {e}")))?;
    let followed: Vec<String> = sqlx::query_scalar(IS_FOLLOWING_SQL)
        .bind(viewer_id)
        .bind(ids_json)
        .fetch_all(&state.db)
        .await?;
    for c in items.iter_mut() {
        c.is_following = c.user.id != viewer_id && followed.iter().any(|f| f == &c.user.id);
    }
    Ok(())
}

/// `GET /api/creators` (🔓). Order of checks: `sort`, then `page`/`perPage`. Review 12 M1:
/// served from the creators snapshot (up to `CREATORS_TTL_SECS` old); only `isFollowing` is
/// read per request.
pub async fn list_creators(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiQuery(query): ApiQuery<CreatorsQuery>,
) -> AppResult<Json<Page<Creator>>> {
    let sort = CreatorSort::parse(query.sort.as_deref())?;
    let (page, per_page) = parse_paging(
        query.page.as_deref(),
        query.per_page.as_deref(),
        CREATORS_PER_PAGE_DEFAULT,
    )?;
    let per_page = per_page.clamp(1, CREATORS_PER_PAGE_MAX);
    let offset = page_offset(page, per_page);

    let snap = creators_snapshot::snapshot(&state).await;
    let total = snap.len() as i64;
    let mut items = snap.page(sort, offset, per_page);
    drop(snap);
    apply_is_following(&state, viewer.id(), &mut items).await?;

    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

/// Largest number of games in [`CreatorSpotlight::games`].
pub const SPOTLIGHT_GAMES_MAX: i64 = 3;

/// F032 `GET /api/creators/spotlight` response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorSpotlight {
    /// The UTC date the pick belongs to, `YYYY-MM-DD`.
    pub day: String,
    pub creator: Option<Creator>,
    pub games: Vec<GameSummary>,
}

/// The F032 pick: `day mod n` (0-based, never negative). `n` must be positive.
pub fn spotlight_index(day: i64, n: i64) -> i64 {
    day.rem_euclid(n)
}

/// Whole days from 1970-01-01 to `now`'s UTC date.
pub fn utc_day_number(now: DateTime<Utc>) -> i64 {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid date");
    now.date_naive().signed_duration_since(epoch).num_days()
}

/// Spotlight games: the creator's own featured games first (featured order), then their other
/// published games by plays. `?1` = creator id.
fn spotlight_games_sql() -> String {
    format!(
        "{GAME_SELECT} LEFT JOIN profile_featured pf \
           ON pf.game_id = g.id AND pf.user_id = g.owner_id \
         WHERE g.owner_id = ?1 AND g.published = 1 \
         ORDER BY (pf.position IS NULL), pf.position, g.plays DESC, g.created_at DESC, g.id \
         LIMIT {SPOTLIGHT_GAMES_MAX}"
    )
}

/// `GET /api/creators/spotlight` (🔓, F032). The eligible creators, `N` and the creator row
/// come from the creators snapshot (review 12 M1), ordered by user id; the games and
/// `isFollowing` are read live.
pub async fn get_spotlight(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
) -> AppResult<Json<CreatorSpotlight>> {
    let now = Utc::now();
    let day = now.format("%Y-%m-%d").to_string();
    let snap = creators_snapshot::snapshot(&state).await;
    let n = snap.len() as i64;
    let creator = if n > 0 {
        let index = spotlight_index(utc_day_number(now), n);
        snap.by_id_index(index as usize)
    } else {
        None
    };
    drop(snap);
    let Some(creator) = creator else {
        return Ok(Json(CreatorSpotlight {
            day,
            creator: None,
            games: Vec::new(),
        }));
    };
    let rows = sqlx::query(&spotlight_games_sql())
        .bind(&creator.user.id)
        .fetch_all(&state.db)
        .await?;
    let games = rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| g.summary()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut one = [creator];
    apply_is_following(&state, viewer.id(), &mut one).await?;
    let [creator] = one;
    Ok(Json(CreatorSpotlight {
        day,
        creator: Some(creator),
        games,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_parsing() {
        assert_eq!(CreatorSort::parse(None).unwrap(), CreatorSort::Popular);
        assert_eq!(CreatorSort::parse(Some("")).unwrap(), CreatorSort::Popular);
        assert_eq!(
            CreatorSort::parse(Some("popular")).unwrap(),
            CreatorSort::Popular
        );
        assert_eq!(
            CreatorSort::parse(Some("active")).unwrap(),
            CreatorSort::Active
        );
        assert_eq!(CreatorSort::parse(Some("new")).unwrap(), CreatorSort::New);
        match CreatorSort::parse(Some("top")) {
            Err(AppError::BadRequest(m)) => {
                assert_eq!(m, "Unknown sort 'top' (expected popular, active or new)")
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn spotlight_pick() {
        assert_eq!(spotlight_index(0, 3), 0);
        assert_eq!(spotlight_index(4, 3), 1);
        assert_eq!(spotlight_index(-1, 3), 2);
        let d = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
        assert_eq!(utc_day_number(d("1970-01-01T23:59:59Z")), 0);
        assert_eq!(utc_day_number(d("1970-01-02T00:00:00Z")), 1);
        assert_eq!(utc_day_number(d("1969-12-31T12:00:00Z")), -1);
        assert_eq!(utc_day_number(d("2026-11-19T10:00:00+05:00")), 20_776);
        // A local time whose UTC date is the day before.
        assert_eq!(utc_day_number(d("2026-11-20T03:00:00+05:00")), 20_776);
    }

    #[test]
    fn creator_sql_owner_filter() {
        assert!(!creator_sql(false, "u.id ASC").contains("?3"));
        let one = creator_sql(true, "u.username_lower ASC");
        assert!(one.contains("WHERE published = 1 AND owner_id = ?3 GROUP BY owner_id"));
        assert!(one.contains("ORDER BY u.username_lower ASC"));
    }
}
