//! WebGameApp backend: REST API, game hosting and player page.

pub mod auth;
pub mod bundle;
pub mod config;
pub mod db;
pub mod error;
pub mod extract;
pub mod models;
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
}

impl AppState {
    /// Create the data directories, open the database and run migrations.
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let storage = Storage::new(&config.data_dir);
        storage.ensure_dirs()?;
        let db = db::connect(&config.database_url).await?;
        Ok(Self {
            db,
            config: Arc::new(config),
            storage,
        })
    }
}

/// Build the full application router.
pub fn app(state: AppState) -> Router {
    routes::router(state)
}
