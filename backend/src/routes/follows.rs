//! F002 follows: PUT/DELETE /api/users/{username}/follow, GET …/followers and …/following.

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::extract::{ApiPath, ApiQuery};
use crate::models::{Page, UserRef, now_rfc3339, user_ref_from_row};
use crate::ratelimit::Limit;
use crate::routes::comments::PageQuery;
use crate::routes::games::{limit_user, parse_paging};

/// A user may follow at most this many users.
pub const FOLLOW_CAP: i64 = 2000;

#[derive(Serialize)]
pub struct FollowResponse {
    pub following: bool,
    /// The target's follower count after the change.
    pub followers: i64,
}

/// `(followers, following)` of a user.
pub async fn follow_counts(db: &SqlitePool, user_id: &str) -> AppResult<(i64, i64)> {
    let row: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ?1), \
                (SELECT COUNT(*) FROM follows WHERE follower_id = ?1)",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub async fn is_following(db: &SqlitePool, follower: &str, followee: &str) -> AppResult<bool> {
    let r: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?")
            .bind(follower)
            .bind(followee)
            .fetch_optional(db)
            .await?;
    Ok(r.is_some())
}

/// Resolve a username case-insensitively to a user id (404 `not_found` "User").
pub async fn resolve_user_id(db: &SqlitePool, username: &str) -> AppResult<String> {
    sqlx::query_scalar("SELECT id FROM users WHERE username_lower = ?")
        .bind(username.to_ascii_lowercase())
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("User"))
}

async fn target_for(state: &AppState, user: &AuthUser, username: &str) -> AppResult<String> {
    limit_user(state, Limit::Follow, &user.id)?;
    let target = resolve_user_id(&state.db, username).await?;
    if target == user.id {
        return Err(AppError::validation("You cannot follow yourself"));
    }
    Ok(target)
}

async fn follower_count(db: &SqlitePool, user_id: &str) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM follows WHERE followee_id = ?")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}

/// PUT /api/users/{username}/follow (🔒, idempotent).
pub async fn put_follow(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(username): ApiPath<String>,
) -> AppResult<Json<FollowResponse>> {
    let target = target_for(&state, &user, &username).await?;
    if !is_following(&state.db, &user.id, &target).await? {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM follows WHERE follower_id = ?")
            .bind(&user.id)
            .fetch_one(&state.db)
            .await?;
        if n >= FOLLOW_CAP {
            return Err(AppError::validation(format!(
                "You can follow at most {FOLLOW_CAP} users"
            )));
        }
        sqlx::query(
            "INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?) \
             ON CONFLICT (follower_id, followee_id) DO NOTHING",
        )
        .bind(&user.id)
        .bind(&target)
        .bind(now_rfc3339())
        .execute(&state.db)
        .await?;
    }
    Ok(Json(FollowResponse {
        following: true,
        followers: follower_count(&state.db, &target).await?,
    }))
}

/// DELETE /api/users/{username}/follow (🔒, idempotent; 200 even if not following).
pub async fn delete_follow(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(username): ApiPath<String>,
) -> AppResult<Json<FollowResponse>> {
    let target = target_for(&state, &user, &username).await?;
    sqlx::query("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?")
        .bind(&user.id)
        .bind(&target)
        .execute(&state.db)
        .await?;
    Ok(Json(FollowResponse {
        following: false,
        followers: follower_count(&state.db, &target).await?,
    }))
}

/// One page of the users on the `other` side of `follows` rows whose `side` is `user_id`,
/// newest follow first.
async fn list_side(
    state: &AppState,
    username: &str,
    query: PageQuery,
    side: &str,
    other: &str,
) -> AppResult<Json<Page<UserRef>>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;
    let user_id = resolve_user_id(&state.db, username).await?;
    // `side`/`other` are the two static column names, never user input.
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM follows WHERE {side} = ?"))
        .bind(&user_id)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&format!(
        "SELECT u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name, \
           u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version \
         FROM follows f JOIN users u ON u.id = f.{other} \
         WHERE f.{side} = ? ORDER BY f.created_at DESC, f.rowid DESC LIMIT ? OFFSET ?"
    ))
    .bind(&user_id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .iter()
        .map(|r| user_ref_from_row(r, "u_"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

/// GET /api/users/{username}/followers: who follows the user.
pub async fn list_followers(
    State(state): State<AppState>,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<UserRef>>> {
    list_side(&state, &username, query, "followee_id", "follower_id").await
}

/// GET /api/users/{username}/following: whom the user follows.
pub async fn list_following(
    State(state): State<AppState>,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<UserRef>>> {
    list_side(&state, &username, query, "follower_id", "followee_id").await
}
