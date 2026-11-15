//! WebGameApp backend: REST API, game hosting and player page.

pub mod activity;
pub mod auth;
pub mod bests;
pub mod bundle;
pub mod config;
pub mod controls_backfill;
pub mod db;
pub mod error;
pub mod export;
pub mod extract;
pub mod locks;
pub mod models;
pub mod notifications;
pub mod ratelimit;
pub mod routes;
pub mod screenshots;
pub mod seed;
pub mod storage;
pub mod trending;
pub mod versions;

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
    /// F003 trending snapshot freshness + single flight.
    pub trending: trending::TrendingCache,
    /// F013: concurrent bundle-download builds (`EXPORT_SLOTS` permits, `try_acquire`).
    pub export_slots: Arc<tokio::sync::Semaphore>,
    /// F005: concurrent screenshot decodes (`IMAGE_SLOTS` permits, `try_acquire`).
    pub image_slots: Arc<tokio::sync::Semaphore>,
    /// L4: serialises the deferred `score_bests` rebuilds ([`bests::spawn_rebuild`]).
    pub bests_rebuild: Arc<tokio::sync::Mutex<()>>,
    /// L4: count of finished background rebuild runs (tests await it instead of polling).
    pub bests_runs: Arc<tokio::sync::watch::Sender<u64>>,
}

/// F013: at most this many `GET /api/games/{id}/bundle` archives are built at once.
pub const EXPORT_SLOTS: usize = 2;

/// F005: at most this many screenshot uploads are decoded / re-encoded at once.
pub const IMAGE_SLOTS: usize = 2;

impl AppState {
    /// Create the data directories, open the database and run migrations.
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let storage = Storage::new(&config.data_dir);
        storage.ensure_dirs()?;
        let db = db::connect(&config.database_url).await?;
        apply_admin_roles(&db, &config.admin_usernames).await?;
        let state = Self {
            db,
            limiter: ratelimit::RateLimiter::new(config.rate_limit),
            bundle_locks: locks::KeyLocks::new(),
            play_dedupe: ratelimit::PlayDedupe::new(),
            trending: trending::TrendingCache::new(),
            export_slots: Arc::new(tokio::sync::Semaphore::new(EXPORT_SLOTS)),
            image_slots: Arc::new(tokio::sync::Semaphore::new(IMAGE_SLOTS)),
            bests_rebuild: Arc::new(tokio::sync::Mutex::new(())),
            bests_runs: Arc::new(tokio::sync::watch::Sender::new(0)),
            config: Arc::new(config),
            storage,
        };
        // F003: refresh the trending snapshot once at startup (failures are logged). Later
        // refreshes run in `trending::spawn_maintenance` (started by `serve`).
        state.trending.refresh_now(&state.db).await;
        Ok(state)
    }

    /// Replace the rate limiter's clock (M2: tests use a [`ratelimit::ManualClock`]). Call
    /// before building the router; existing buckets are dropped.
    pub fn with_clock(mut self, clock: ratelimit::Clock) -> Self {
        self.limiter = ratelimit::RateLimiter::with_clock(self.config.rate_limit, clock);
        self
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
/// create). F005: also removes screenshot files without a row and stray `.*.tmp` files in
/// `data/screenshots`. Returns the number of removed directories and files.
pub async fn sweep_stale_files(state: &AppState) -> anyhow::Result<usize> {
    let mut removed = sweep_screenshot_files(state).await?;
    let ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM games")
        .fetch_all(&state.db)
        .await?;
    let known: std::collections::HashSet<String> = ids.into_iter().map(|(i,)| i).collect();
    let mut games = match tokio::fs::read_dir(state.storage.games_root()).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
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

/// F005 part of [`sweep_stale_files`]: screenshot files whose id has no row, and stray
/// `.*.tmp` files left by an interrupted write.
async fn sweep_screenshot_files(state: &AppState) -> anyhow::Result<usize> {
    let mut dir = match tokio::fs::read_dir(state.storage.screenshots_dir()).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM screenshots")
        .fetch_all(&state.db)
        .await?;
    let known: std::collections::HashSet<String> = ids.into_iter().map(|(i,)| i).collect();
    let mut removed = 0;
    while let Some(entry) = dir.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale = if name.starts_with('.') && name.ends_with(".tmp") {
            true
        } else {
            screenshots::id_of_file(&name).is_none_or(|id| !known.contains(id))
        };
        if stale && tokio::fs::remove_file(entry.path()).await.is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Build the full application router.
pub fn app(state: AppState) -> Router {
    routes::router(state)
}
