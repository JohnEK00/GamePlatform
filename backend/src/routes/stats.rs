//! Creator analytics: GET /api/users/me/stats, GET /api/games/{id}/stats (owner).

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
use sqlx::Row;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::AppResult;
use crate::extract::ApiPath;
use crate::models::rating_avg;
use crate::routes::games::fetch_owned_game;

pub const STATS_DAYS: i64 = 30;

#[derive(Debug, Serialize)]
pub struct DailyPlays {
    pub date: String,
    pub plays: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorTotals {
    pub games: i64,
    pub published: i64,
    pub plays: i64,
    pub favorites: i64,
    pub comments: i64,
    pub rating_count: i64,
    pub rating_avg: f64,
}

#[derive(Serialize)]
pub struct CreatorStats {
    pub totals: CreatorTotals,
    pub daily: Vec<DailyPlays>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStats {
    pub plays: i64,
    pub favorites: i64,
    pub comments: i64,
    pub unique_players: i64,
    pub daily: Vec<DailyPlays>,
}

/// The last [`STATS_DAYS`] UTC dates ending today, oldest first.
pub fn last_days(today: NaiveDate) -> Vec<String> {
    (0..STATS_DAYS)
        .rev()
        .map(|i| (today - Duration::days(i)).format("%Y-%m-%d").to_string())
        .collect()
}

/// Zero-filled daily series from per-day counts.
pub fn zero_fill(today: NaiveDate, counts: &HashMap<String, i64>) -> Vec<DailyPlays> {
    last_days(today)
        .into_iter()
        .map(|date| DailyPlays {
            plays: counts.get(&date).copied().unwrap_or(0),
            date,
        })
        .collect()
}

/// Daily play counts for the games matched by `game_filter` (an SQL condition on `e.game_id`
/// with exactly one `?` bound to `bind`).
async fn daily_series(
    state: &AppState,
    game_filter: &str,
    bind: &str,
) -> AppResult<Vec<DailyPlays>> {
    let today = Utc::now().date_naive();
    let first = last_days(today).remove(0);
    let rows = sqlx::query(&format!(
        "SELECT e.day, COUNT(*) AS n FROM play_events e WHERE {game_filter} AND e.day >= ? \
         GROUP BY e.day"
    ))
    .bind(bind)
    .bind(&first)
    .fetch_all(&state.db)
    .await?;
    let mut counts = HashMap::new();
    for r in &rows {
        counts.insert(r.try_get::<String, _>("day")?, r.try_get::<i64, _>("n")?);
    }
    Ok(zero_fill(today, &counts))
}

pub async fn my_stats(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<CreatorStats>> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS games, COALESCE(SUM(published), 0) AS published, \
           COALESCE(SUM(plays), 0) AS plays, COALESCE(SUM(rating_sum), 0) AS rating_sum, \
           COALESCE(SUM(rating_count), 0) AS rating_count, \
           (SELECT COUNT(*) FROM favorites f JOIN games g2 ON g2.id = f.game_id \
              WHERE g2.owner_id = ?1) AS favorites, \
           (SELECT COUNT(*) FROM comments c JOIN games g3 ON g3.id = c.game_id \
              WHERE g3.owner_id = ?1) AS comments \
         FROM games WHERE owner_id = ?1",
    )
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    let rating_sum: i64 = row.try_get("rating_sum")?;
    let rating_count: i64 = row.try_get("rating_count")?;
    let totals = CreatorTotals {
        games: row.try_get("games")?,
        published: row.try_get("published")?,
        plays: row.try_get("plays")?,
        favorites: row.try_get("favorites")?,
        comments: row.try_get("comments")?,
        rating_count,
        rating_avg: rating_avg(rating_sum, rating_count),
    };
    let daily = daily_series(
        &state,
        "e.game_id IN (SELECT id FROM games WHERE owner_id = ?)",
        &user.id,
    )
    .await?;
    Ok(Json(CreatorStats { totals, daily }))
}

pub async fn game_stats(
    State(state): State<AppState>,
    user: AuthUser,
    ApiPath(id): ApiPath<String>,
) -> AppResult<Json<GameStats>> {
    let game = fetch_owned_game(&state, &id, &user.id).await?;
    let row = sqlx::query(
        "SELECT \
           (SELECT COUNT(*) FROM favorites WHERE game_id = ?1) AS favorites, \
           (SELECT COUNT(*) FROM comments WHERE game_id = ?1) AS comments, \
           (SELECT COUNT(*) FROM ( \
              SELECT user_id FROM scores WHERE game_id = ?1 \
              UNION SELECT user_id FROM saves WHERE game_id = ?1 \
              UNION SELECT user_id FROM user_achievements WHERE game_id = ?1)) AS unique_players",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let daily = daily_series(&state, "e.game_id = ?", &id).await?;
    Ok(Json(GameStats {
        plays: game.plays,
        favorites: row.try_get("favorites")?,
        comments: row.try_get("comments")?,
        unique_players: row.try_get("unique_players")?,
        daily,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_fill_is_30_days_oldest_first() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 2).unwrap();
        let mut counts = HashMap::new();
        counts.insert("2026-03-02".to_string(), 4);
        counts.insert("2026-02-28".to_string(), 2);
        counts.insert("2026-01-01".to_string(), 9); // out of range
        let d = zero_fill(today, &counts);
        assert_eq!(d.len(), 30);
        assert_eq!(d[0].date, "2026-02-01");
        assert_eq!(d[29].date, "2026-03-02");
        assert_eq!(d[29].plays, 4);
        assert_eq!(d[27].date, "2026-02-28");
        assert_eq!(d[27].plays, 2);
        assert_eq!(d.iter().map(|x| x.plays).sum::<i64>(), 6);
    }
}
