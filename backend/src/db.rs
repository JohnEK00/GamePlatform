//! Database pool creation and migrations.

use std::str::FromStr;
use std::time::Duration;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    let in_memory = database_url.contains(":memory:");
    let mut opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    if !in_memory {
        opts = opts
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        if let Some(parent) = opts.get_filename().parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
    }
    let max = if in_memory { 1 } else { 8 };
    let pool = SqlitePoolOptions::new()
        .max_connections(max)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
