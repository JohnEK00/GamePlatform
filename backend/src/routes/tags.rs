//! GET /api/tags

use axum::Json;
use axum::extract::State;

use crate::AppState;
use crate::error::AppResult;
use crate::models::TagCount;

pub async fn list_tags(State(state): State<AppState>) -> AppResult<Json<Vec<TagCount>>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT t.tag, COUNT(*) AS cnt FROM game_tags t JOIN games g ON g.id = t.game_id \
         WHERE g.published = 1 GROUP BY t.tag ORDER BY cnt DESC, t.tag ASC LIMIT 50",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect(),
    ))
}
