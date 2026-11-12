//! Game comments.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;
use sqlx::sqlite::SqliteRow;

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiPath, ApiQuery};
use crate::models::{Comment, Page, now_rfc3339, user_ref_from_row};
use crate::routes::games::{fetch_visible_game, parse_paging};

pub const COMMENT_MAX: usize = 2000;

const COMMENT_SELECT: &str = "SELECT c.id, c.game_id, c.body, c.created_at, \
     u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name, \
     u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version \
     FROM comments c JOIN users u ON u.id = c.user_id";

fn comment_from_row(row: &SqliteRow) -> Result<Comment, sqlx::Error> {
    Ok(Comment {
        id: row.try_get("id")?,
        game_id: row.try_get("game_id")?,
        author: user_ref_from_row(row, "a_")?,
        body: row.try_get("body")?,
        created_at: row.try_get("created_at")?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn list_comments(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> AppResult<Json<Page<Comment>>> {
    fetch_visible_game(&state, &game_id, viewer.id()).await?;
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 20)?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE game_id = ?")
        .bind(&game_id)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query(&format!(
        "{COMMENT_SELECT} WHERE c.game_id = ? ORDER BY c.created_at DESC, c.rowid DESC \
         LIMIT ? OFFSET ?"
    ))
    .bind(&game_id)
    .bind(per_page)
    .bind((page - 1) * per_page)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .iter()
        .map(comment_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(Page {
        items,
        total,
        page,
        per_page,
    }))
}

#[derive(Deserialize)]
pub struct CommentBody {
    pub body: String,
}

pub async fn create_comment(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(game_id): ApiPath<String>,
    ApiJson(body): ApiJson<CommentBody>,
) -> AppResult<(StatusCode, Json<Comment>)> {
    fetch_visible_game(&state, &game_id, Some(&user.id)).await?;
    let text = body.body.trim();
    let n = text.chars().count();
    if n == 0 || n > COMMENT_MAX {
        return Err(AppError::validation(format!(
            "Comment must be 1-{COMMENT_MAX} characters"
        )));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO comments (id, game_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&game_id)
    .bind(&user.id)
    .bind(text)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await?;
    let row = sqlx::query(&format!("{COMMENT_SELECT} WHERE c.id = ?"))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(comment_from_row(&row)?)))
}

pub async fn delete_comment(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<StatusCode> {
    let row = sqlx::query(
        "SELECT c.user_id, g.owner_id FROM comments c JOIN games g ON g.id = c.game_id \
         WHERE c.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("Comment"))?;
    let author: String = row.try_get("user_id")?;
    let owner: String = row.try_get("owner_id")?;
    if user.id != author && user.id != owner {
        return Err(AppError::forbidden());
    }
    sqlx::query("DELETE FROM comments WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
