use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;
use webgame_server::{AppState, Config, app, seed, sweep_stale_files};

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
        Some("healthcheck") => healthcheck(config.port).await,
        Some("-h") | Some("--help") => {
            println!(
                "webgame-server            run the HTTP server\n\
                 webgame-server seed <zip>... [--dir <folder>]\n\
                                           create demo/demo12345 and upload bundles\n\
                 webgame-server healthcheck  exit 0 if the local server answers /api/health"
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
            "PUBLIC_ORIGIN is not set; /play derives its origin from the request Host and \
             X-Forwarded-Proto headers (set PUBLIC_ORIGIN in production)"
        ),
    }
    if !config.admin_usernames.is_empty() {
        tracing::info!(
            count = config.admin_usernames.len(),
            "ADMIN_USERNAMES applied"
        );
    }
    if !config.rate_limit {
        tracing::warn!("rate limiting is disabled (RATE_LIMIT=off)");
    }
    let state = AppState::new(config).await?;
    match sweep_stale_files(&state).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(removed = n, "removed stale upload/staging directories"),
        Err(e) => tracing::warn!(error = %e, "startup cleanup of stale directories failed"),
    }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    tracing::info!("server stopped");
    Ok(())
}

/// Resolves on Ctrl+C (SIGINT) or, on Unix, SIGTERM (`docker stop`; the server is PID 1 in
/// the container). In-flight requests are then drained by axum's graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %e, "cannot listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::warn!(error = %e, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => tracing::info!("Ctrl+C received, shutting down"),
        _ = terminate => tracing::info!("SIGTERM received, shutting down"),
    }
}

/// `webgame-server healthcheck`: GET /api/health on the local port; exit 0 when it answers
/// 200. Used by the Docker HEALTHCHECK (no curl in the image).
async fn healthcheck(port: u16) -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fut = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        stream
            .write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await?;
        anyhow::Ok(buf)
    };
    let buf = tokio::time::timeout(std::time::Duration::from_secs(5), fut).await??;
    let head = String::from_utf8_lossy(&buf[..buf.len().min(64)]).into_owned();
    let ok = head
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code == "200");
    if ok {
        Ok(())
    } else {
        anyhow::bail!("unhealthy: {}", head.lines().next().unwrap_or(""))
    }
}
