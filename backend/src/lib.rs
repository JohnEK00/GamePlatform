//! WebGameApp backend: REST API, game hosting and player page.

pub mod activity;
pub mod auth;
pub mod bundle;
pub mod config;
pub mod db;
pub mod error;
pub mod extract;
pub mod locks;
pub mod models;
pub mod ratelimit;
pub mod routes;
pub mod seed;
pub mod storage;

use std::sync::Arc;

use axum::Router;
use sqlx::SqlitePool;

pub use config::Config;
pub use error::{AppError, AppResult};
pub use storage::Storage;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<Config>,
    pub storage: Storage,
    pub limiter: ratelimit::RateLimiter,
    /// Per-game claims serialising bundle replaces (R1).
    pub bundle_locks: locks::KeyLocks,
    /// Per-(game, viewer) play-count dedupe window (R2).
    pub play_dedupe: ratelimit::PlayDedupe,
}

impl AppState {
    /// Create the data directories, open the database and run migrations.
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let storage = Storage::new(&config.data_dir);
        storage.ensure_dirs()?;
        let db = db::connect(&config.database_url).await?;
        apply_admin_roles(&db, &config.admin_usernames).await?;
        Ok(Self {
            db,
            limiter: ratelimit::RateLimiter::new(config.rate_limit),
            bundle_locks: locks::KeyLocks::new(),
            play_dedupe: ratelimit::PlayDedupe::new(),
            config: Arc::new(config),
            storage,
        })
    }
}

/// `ADMIN_USERNAMES` is the source of truth for roles: listed users become `admin`,
/// everyone else `user`.
pub async fn apply_admin_roles(db: &SqlitePool, admins: &[String]) -> anyhow::Result<()> {
    let list = serde_json::to_string(admins)?;
    sqlx::query(
        "UPDATE users SET role = CASE WHEN username_lower IN (SELECT value FROM json_each(?)) THEN 'admin' ELSE 'user' END",
    )
    .bind(list)
    .execute(db)
    .await?;
    Ok(())
}

/// Startup cleanup (call before serving, never while requests run): removes `.staging-*`
/// dirs left by interrupted uploads, and game dirs that have no DB row (an interrupted
/// create). Returns the number of removed directories.
pub async fn sweep_stale_files(state: &AppState) -> anyhow::Result<usize> {
    let ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM games")
        .fetch_all(&state.db)
        .await?;
    let known: std::collections::HashSet<String> = ids.into_iter().map(|(i,)| i).collect();
    let mut removed = 0;
    let mut games = match tokio::fs::read_dir(state.storage.games_root()).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    while let Some(entry) = games.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !known.contains(&name) {
            if tokio::fs::remove_dir_all(entry.path()).await.is_ok() {
                removed += 1;
            }
            continue;
        }
        let mut inner = tokio::fs::read_dir(entry.path()).await?;
        while let Some(sub) = inner.next_entry().await? {
            if sub.file_name().to_string_lossy().starts_with(".staging-")
                && tokio::fs::remove_dir_all(sub.path()).await.is_ok()
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Build the full application router.
pub fn app(state: AppState) -> Router {
    routes::router(state)
}
