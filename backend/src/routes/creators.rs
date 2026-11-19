//! F035: Explore creators (`GET /api/creators`, docs/API.md § F035 additions; SQL in
//! docs/ARCHITECTURE.md § F035 additions).
//!
//! A creator is a user with at least one published game. The list is public and the same for
//! every viewer apart from `isFollowing`; there is no rate limit (like `GET /api/games`).

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::AppState;
use crate::auth::MaybeAuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::ApiQuery;
use crate::models::{Page, UserRef, banner_url, user_ref_from_row};
use crate::routes::games::{page_offset, parse_paging};

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

/// Creators are counted independently of the sort.
const COUNT_SQL: &str = "SELECT COUNT(DISTINCT owner_id) FROM games WHERE published = 1";

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

    /// Fixed `ORDER BY` strings (never built from input); each ends with the unique
    /// case-insensitive username so pages are stable.
    fn order_sql(self) -> &'static str {
        match self {
            Self::Popular => "followers DESC, c.plays DESC, u.username_lower ASC",
            Self::Active => "c.last_act DESC, u.username_lower ASC",
            Self::New => "c.first_pub DESC, u.username_lower ASC",
        }
    }
}

fn page_sql(order: &str) -> String {
    format!(
        "WITH c AS ( \
           SELECT owner_id, \
                  COUNT(*) AS games, \
                  COALESCE(SUM(plays), 0) AS plays, \
                  MIN(COALESCE(first_published_at, created_at)) AS first_pub, \
                  MAX(MAX(COALESCE(first_published_at, created_at), \
                          COALESCE(last_updated_at, ''))) AS last_act \
           FROM games WHERE published = 1 GROUP BY owner_id \
         ) \
         SELECT u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
                u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version, \
                u.banner_ext, u.banner_version, \
                substr(u.bio, 1, {BIO_EXCERPT_CHARS}) AS bio_excerpt, \
                c.games, c.plays, c.first_pub, c.last_act, \
                (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers \
         FROM c JOIN users u ON u.id = c.owner_id \
         ORDER BY {order} \
         LIMIT ?1 OFFSET ?2"
    )
}

/// `GET /api/creators` (🔓). Order of checks: `sort`, then `page`/`perPage`.
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

    let total: i64 = sqlx::query_scalar(COUNT_SQL).fetch_one(&state.db).await?;

    let rows = sqlx::query(&page_sql(sort.order_sql()))
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
    let mut items = Vec::with_capacity(rows.len());
    for r in &rows {
        let user = user_ref_from_row(r, "u_")?;
        let banner_ext: Option<String> = r.try_get("banner_ext")?;
        let banner_version: i64 = r.try_get("banner_version")?;
        let bio: Option<String> = r.try_get("bio_excerpt")?;
        items.push(Creator {
            banner_url: banner_url(&user.id, banner_ext.as_deref(), banner_version),
            user,
            bio_excerpt: bio.unwrap_or_default(),
            games: r.try_get("games")?,
            plays: r.try_get("plays")?,
            followers: r.try_get("followers")?,
            is_following: false,
            first_published_at: r.try_get("first_pub")?,
            last_active_at: r.try_get("last_act")?,
        });
    }

    if let Some(viewer_id) = viewer.id()
        && !items.is_empty()
    {
        let ids: Vec<&str> = items.iter().map(|c| c.user.id.as_str()).collect();
        let ids_json =
            serde_json::to_string(&ids).map_err(|e| AppError::Internal(format!("json: {e}")))?;
        let followed: Vec<String> = sqlx::query_scalar(IS_FOLLOWING_SQL)
            .bind(viewer_id)
            .bind(ids_json)
            .fetch_all(&state.db)
            .await?;
        for c in &mut items {
            c.is_following = followed.iter().any(|f| f == &c.user.id);
        }
    }

    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
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
}
