//! WebGameApp backend: REST API, game hosting and player page.

pub mod auth;
pub mod bundle;
pub mod config;
pub mod db;
pub mod error;
pub mod extract;
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

/// Build the full application router.
pub fn app(state: AppState) -> Router {
    routes::router(state)
}
