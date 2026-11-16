//! F009 startup backfill (docs/ARCHITECTURE.md § F009 additions): fills `games.actions_json`
//! and `games.controls_hint` for games stored before migration `0010_f009.sql`, from their
//! current version's `game.json`.
//!
//! Best effort and idempotent: only rows with `actions_json IS NULL` are touched, and the
//! `UPDATE` is guarded by `version`, so a concurrent bundle replace wins. A failure is logged
//! by the caller and the remaining rows are retried at the next start.

use serde_json::Value;

use crate::AppState;
use crate::bundle::{actions_to_json, parse_actions, parse_controls_hint};

/// Rows fetched per batch.
pub const BATCH: i64 = 200;
/// Stored `game.json` files larger than this are skipped (treated as unreadable).
pub const MAX_GAME_JSON: u64 = 1024 * 1024;

/// `(actions_json, controls_hint)` for a stored game.json; `([], "")` when it is missing,
/// unreadable, too large or not a JSON object. Invalid `actions` → `[]` (logged at `info`).
async fn compute(state: &AppState, id: &str, version: i64) -> (String, String) {
    let path = state.storage.version_dir(id, version).join("game.json");
    let empty = || ("[]".to_string(), String::new());
    match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() && m.len() <= MAX_GAME_JSON => {}
        Ok(_) => {
            tracing::info!(game_id = id, version, "F009 backfill: game.json skipped");
            return empty();
        }
        Err(_) => return empty(),
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return empty();
    };
    if bytes.len() as u64 > MAX_GAME_JSON {
        return empty();
    }
    let v: Value = match serde_json::from_slice(&bytes) {
        Ok(v @ Value::Object(_)) => v,
        _ => return empty(),
    };
    let actions = match parse_actions(&v) {
        Ok(list) => actions_to_json(&list),
        Err(e) => {
            tracing::info!(
                game_id = id,
                version,
                error = %e,
                "F009 backfill: stored actions are invalid; storing []"
            );
            "[]".to_string()
        }
    };
    (actions, parse_controls_hint(&v))
}

/// Backfill every game whose `actions_json` is still `NULL`. Returns the number of updated
/// rows (0 on a second run).
pub async fn backfill_controls(state: &AppState) -> anyhow::Result<usize> {
    let mut updated = 0usize;
    // Rows already tried in this run: a row that is still NULL after its guarded UPDATE
    // (it can't normally happen) must not make the loop spin.
    let mut attempted = std::collections::HashSet::new();
    loop {
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, version FROM games WHERE actions_json IS NULL LIMIT ?")
                .bind(BATCH)
                .fetch_all(&state.db)
                .await?;
        let fresh: Vec<(String, i64)> = rows
            .into_iter()
            .filter(|(id, version)| attempted.insert((id.clone(), *version)))
            .collect();
        if fresh.is_empty() {
            break;
        }
        for (id, version) in fresh {
            let (actions, hint) = compute(state, &id, version).await;
            let res = sqlx::query(
                "UPDATE games SET actions_json = ?, controls_hint = ? \
                 WHERE id = ? AND version = ? AND actions_json IS NULL",
            )
            .bind(&actions)
            .bind(&hint)
            .bind(&id)
            .bind(version)
            .execute(&state.db)
            .await?;
            if res.rows_affected() > 0 {
                updated += 1;
            }
        }
    }
    Ok(updated)
}

/// Spawn [`backfill_controls`] in the background (startup task); the result is logged.
pub fn spawn_backfill(state: &AppState) -> tokio::task::JoinHandle<()> {
    let state = state.clone();
    tokio::spawn(async move {
        match backfill_controls(&state).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(updated = n, "F009 backfill: controls filled"),
            Err(e) => tracing::warn!(error = %e, "F009 backfill failed; retried at next start"),
        }
    })
}
