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
    optimize(&pool, true).await;
    Ok(pool)
}

/// `PRAGMA optimize` (N1): keeps `sqlite_stat1` current so the planner has statistics.
/// `startup` uses `0x10002` (check every table, as recommended for a freshly opened database);
/// periodic runs use the default mask, which only re-analyzes tables that changed enough.
/// `analysis_limit` bounds the cost on large tables. Failures are logged, never fatal.
pub async fn optimize(pool: &SqlitePool, startup: bool) {
    let res: sqlx::Result<()> = async {
        let mut conn = pool.acquire().await?;
        sqlx::query("PRAGMA analysis_limit = 1000")
            .execute(&mut *conn)
            .await?;
        let sql = if startup {
            "PRAGMA optimize = 0x10002"
        } else {
            "PRAGMA optimize"
        };
        sqlx::query(sql).execute(&mut *conn).await?;
        Ok(())
    }
    .await;
    if let Err(e) = res {
        tracing::warn!(error = %e, "PRAGMA optimize failed");
    }
}
