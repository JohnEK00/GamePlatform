//! Favorites: PUT/DELETE /api/games/{id}/favorite, GET /api/users/me/favorites.

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::extract::{ApiPath, ApiQuery};
use crate::models::{GAME_SELECT, GameSummary, Page, game_row_from_row, now_rfc3339};
use crate::routes::comments::PageQuery;
use crate::routes::games::{fetch_visible_game, parse_paging};

#[derive(Serialize)]
pub struct FavoriteResponse {
    pub favorited: bool,
    pub favorites: i64,
}

async fn favorite_count(state: &AppState, game_id: &str) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM favorites WHERE game_id = ?")
            .bind(game_id)
            .fetch_one(&state.db)
            .await?,
    )
}

pub async fn put_favorite(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<FavoriteResponse>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    sqlx::query(
        "INSERT INTO favorites (user_id, game_id, created_at) VALUES (?, ?, ?) \
         ON CONFLICT (user_id, game_id) DO NOTHING",
    )
    .bind(&user.id)
    .bind(&id)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?;
    Ok(Json(FavoriteResponse {
        favorited: true,
        favorites: favorite_count(&state, &id).await?,
    }))
}

pub async fn delete_favorite(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<FavoriteResponse>> {
    fetch_visible_game(&state, &id, Some(&user.id)).await?;
    sqlx::query("DELETE FROM favorites WHERE user_id = ? AND game_id = ?")
        .bind(&user.id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(Json(FavoriteResponse {
        favorited: false,
        favorites: favorite_count(&state, &id).await?,
    }))
}

/// My favorites, newest favorite first. Games that became invisible to me (unpublished by
/// their owner) are left out.
pub async fn my_favorites(
    State(state): State<AppState>,
    user: AuthUser,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<GameSummary>>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;
    let visible = "(g.published = 1 OR g.owner_id = ?1)";
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM favorites fv JOIN games g ON g.id = fv.game_id \
         WHERE fv.user_id = ?1 AND {visible}"
    ))
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    let sql = GAME_SELECT.replacen(
        "FROM games g JOIN users u ON u.id = g.owner_id",
        "FROM favorites fv JOIN games g ON g.id = fv.game_id JOIN users u ON u.id = g.owner_id",
        1,
    );
    let rows = sqlx::query(&format!(
        "{sql} WHERE fv.user_id = ?1 AND {visible} \
         ORDER BY fv.created_at DESC, fv.rowid DESC LIMIT ?2 OFFSET ?3"
    ))
    .bind(&user.id)
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
