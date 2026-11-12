use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;
use webgame_server::{AppState, Config, app, seed};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,webgame_server=debug,tower_http=info")),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = Config::from_env().map_err(|e| anyhow::anyhow!(e))?;

    match args.first().map(String::as_str) {
        Some("seed") => {
            let zips = seed::collect_zips(&args[1..])?;
            let state = AppState::new(config).await?;
            seed::run(&state, &zips).await?;
            Ok(())
        }
        Some("--seed-dir") => {
            let zips = seed::collect_zips(&args)?;
            let state = AppState::new(config).await?;
            seed::run(&state, &zips).await?;
            Ok(())
        }
        Some("-h") | Some("--help") => {
            println!(
                "webgame-server            run the HTTP server\n\
                 webgame-server seed <zip>... [--dir <folder>]\n\
                                           create demo/demo12345 and upload bundles"
            );
            Ok(())
        }
        Some(other) => anyhow::bail!("unknown argument '{other}' (try --help)"),
        None => serve(config).await,
    }
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    if !config.engine_dist.join("engine.js").exists() {
        tracing::warn!(
            path = %config.engine_dist.display(),
            "engine.js not found; /runtime/engine.js will return 503 until the engine is built"
        );
    }
    match &config.public_origin {
        Some(origin) => {
            tracing::info!(%origin, "PUBLIC_ORIGIN set; /play uses it as the page origin")
        }
        None => tracing::warn!(
            "PUBLIC_ORIGIN is not set; /play derives its origin from the request Host and              X-Forwarded-Proto headers (set PUBLIC_ORIGIN in production)"
        ),
    }
    let state = AppState::new(config).await?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}
