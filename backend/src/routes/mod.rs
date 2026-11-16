//! Router assembly: `/api` (strict CORS) + public hosting routes (`*` CORS).

pub mod achievements;
pub mod auth;
pub mod comments;
pub mod favorites;
pub mod feed;
pub mod files;
pub mod follows;
pub mod games;
pub mod notifications;
pub mod play;
pub mod related;
pub mod reports;
pub mod saves;
pub mod scores;
pub mod screenshots;
pub mod stats;
pub mod tags;
pub mod users;
pub mod versions;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{HeaderName, HeaderValue, Method, header};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::AppState;
use crate::error::AppError;

pub const UPLOAD_BODY_LIMIT: usize = 60 * 1024 * 1024;
pub const IMAGE_BODY_LIMIT: usize = 3 * 1024 * 1024;
/// F013: the version a downloaded bundle belongs to (lowercase for `HeaderName::from_static`).
pub const GAME_VERSION_HEADER: &str = "x-game-version";

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

async fn api_not_found() -> AppError {
    AppError::NotFound("No such API endpoint".into())
}

pub fn api_router() -> Router<AppState> {
    let upload_limit = DefaultBodyLimit::max(UPLOAD_BODY_LIMIT);
    let image_limit = DefaultBodyLimit::max(IMAGE_BODY_LIMIT);
    Router::new()
        .route("/health", get(health))
        // auth
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/me", get(auth::me))
        // users
        .route("/users/me", axum::routing::patch(users::update_me))
        .route(
            "/users/me/avatar",
            put(users::upload_avatar).layer(image_limit),
        )
        .route("/users/me/favorites", get(favorites::my_favorites))
        .route("/users/me/stats", get(stats::my_stats))
        .route("/users/{username}", get(users::get_user))
        .route(
            "/users/{username}/achievements",
            get(achievements::list_user_achievements),
        )
        // F002 follows + feed
        .route(
            "/users/{username}/follow",
            put(follows::put_follow).delete(follows::delete_follow),
        )
        .route("/users/{username}/followers", get(follows::list_followers))
        .route("/users/{username}/following", get(follows::list_following))
        .route("/feed", get(feed::get_feed))
        .route("/feed/suggestions", get(feed::get_suggestions))
        // F007 notifications (literal paths, so a later `/notifications/{id}` can't clash)
        .route("/notifications", get(notifications::list))
        .route(
            "/notifications/unread-count",
            get(notifications::unread_count),
        )
        .route("/notifications/read", post(notifications::mark_read))
        .route(
            "/notifications/settings",
            get(notifications::get_settings).put(notifications::put_settings),
        )
        // games
        .route(
            "/games",
            get(games::list_games)
                .post(games::create_game)
                .layer(upload_limit),
        )
        .route(
            "/games/{id}",
            get(games::get_game)
                .patch(games::update_game)
                .delete(games::delete_game),
        )
        .route(
            "/games/{id}/bundle",
            get(games::download_bundle)
                .put(games::upload_bundle)
                .layer(upload_limit),
        )
        .route(
            "/games/{id}/thumbnail",
            put(games::upload_thumbnail).layer(image_limit),
        )
        .route("/games/{id}/versions", get(versions::list_versions))
        .route(
            "/games/{id}/versions/{version}",
            axum::routing::patch(versions::update_version_notes),
        )
        .route("/games/{id}/play", post(games::record_play))
        .route("/games/{id}/related", get(related::related_games))
        .route("/games/{id}/preview-token", post(games::preview_token))
        .route(
            "/games/{id}/rating",
            put(games::put_rating).delete(games::delete_rating),
        )
        .route(
            "/games/{id}/comments",
            get(comments::list_comments).post(comments::create_comment),
        )
        .route(
            "/comments/{id}",
            get(comments::get_comment).delete(comments::delete_comment),
        )
        .route("/comments/{id}/replies", get(comments::list_replies))
        .route(
            "/comments/{id}/heart",
            put(comments::heart).delete(comments::unheart),
        )
        // F017 creator thread tools
        .route(
            "/comments/{id}/pin",
            put(comments::pin).delete(comments::unpin),
        )
        .route(
            "/comments/{id}/lock",
            put(comments::lock).delete(comments::unlock),
        )
        // F005 screenshots
        .route(
            "/games/{id}/screenshots",
            get(screenshots::list_screenshots)
                .post(screenshots::create_screenshot)
                .layer(image_limit),
        )
        .route("/screenshots/{id}", delete(screenshots::delete_screenshot))
        .route(
            "/games/{id}/scores",
            get(scores::list_scores).post(scores::submit_score),
        )
        .route("/games/{id}/leaderboard", get(scores::get_leaderboard))
        .route(
            "/games/{id}/favorite",
            put(favorites::put_favorite).delete(favorites::delete_favorite),
        )
        .route(
            "/games/{id}/achievements",
            get(achievements::list_game_achievements),
        )
        .route(
            "/games/{id}/achievements/{achievement_id}",
            post(achievements::unlock_achievement),
        )
        .route(
            "/games/{id}/save",
            get(saves::get_save)
                .put(saves::put_save)
                .delete(saves::delete_save),
        )
        .route("/games/{id}/stats", get(stats::game_stats))
        .route("/reports", post(reports::create_report))
        .route("/admin/reports", get(reports::admin_list_reports))
        .route(
            "/admin/reports/{id}/resolve",
            post(reports::admin_resolve_report),
        )
        .route("/tags", get(tags::list_tags))
        .fallback(api_not_found)
}

pub fn public_router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/play/studio", get(play::studio_page))
        .route("/play/{id}", get(play::play_page))
        .route(
            "/runtime/{*path}",
            get(files::runtime_file).layer(files::compression()),
        )
        .route(
            "/games/{id}/files/{*path}",
            get(files::game_file).layer(files::compression()),
        )
        .nest_service(
            "/media/thumbnails",
            ServeDir::new(state.storage.thumbnails_dir()),
        )
        .nest_service("/media/avatars", ServeDir::new(state.storage.avatars_dir()))
        .nest_service(
            "/media/screenshots",
            Router::new()
                .fallback_service(ServeDir::new(state.storage.screenshots_dir()))
                .layer(axum::middleware::map_response(screenshot_media_headers)),
        )
}

/// L8: `Cache-Control` of stored screenshot files (full image and thumbnail). The bytes never
/// change, but a moderation delete must reach caches: without `immutable` and with a 1 hour
/// lifetime, browsers and shared caches revalidate (cheap `If-Modified-Since` → 304) and get
/// the 404 within an hour of a delete.
pub const SCREENSHOT_CACHE_CONTROL: &str = "public, max-age=3600";

/// F005: stored screenshots must never be sniffed or run as a document. Successful responses
/// are cacheable for [`SCREENSHOT_CACHE_CONTROL`]; anything else (404 after a delete) is
/// `no-store`.
async fn screenshot_media_headers(mut res: axum::response::Response) -> axum::response::Response {
    let ok = res.status().is_success() || res.status() == axum::http::StatusCode::NOT_MODIFIED;
    let h = res.headers_mut();
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if ok {
            SCREENSHOT_CACHE_CONTROL
        } else {
            "no-store"
        }),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    res
}

fn api_cors(origins: &[String]) -> CorsLayer {
    let list: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(list))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        // F013: the bundle download's version and file name are read cross-origin.
        .expose_headers([
            HeaderName::from_static(GAME_VERSION_HEADER),
            header::CONTENT_DISPOSITION,
            header::RETRY_AFTER,
        ])
        .max_age(std::time::Duration::from_secs(3600))
}

fn public_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::OPTIONS])
        .allow_headers(Any)
}

async fn not_found_fallback() -> AppError {
    AppError::NotFound("Not found".into())
}

/// Review 5 M1: `Cache-Control` of the content-hashed build output under `WEB_DIST/assets/`.
pub const SPA_ASSET_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// The web app (`WEB_DIST`), review 5 M1:
/// - `/assets/*` (Vite's content-hashed files) are served with [`SPA_ASSET_CACHE_CONTROL`];
///   a missing asset is a plain 404 (never `index.html`, which would then be cached as JS).
/// - Everything else falls back to `index.html` (client-side routes) with `no-cache`, so a
///   deploy is picked up on the next load.
/// - `*.map` is never served (404), even if a build left source maps in `WEB_DIST`.
/// - Text responses are gzipped ([`files::compression`]); `ServeDir` validates with
///   `Last-Modified`, which is the same for both encodings.
fn spa_router(dir: &std::path::Path) -> Router {
    let index = dir.join("index.html");
    Router::new()
        .nest_service("/assets", ServeDir::new(dir.join("assets")))
        .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        .layer(axum::middleware::from_fn(spa_headers))
        .layer(files::compression())
}

/// Percent-decode a URL path for the `.map` check (invalid escapes are kept as they are).
fn percent_decode(path: &str) -> String {
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn spa_headers(req: Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = percent_decode(req.uri().path()).to_ascii_lowercase();
    if path.trim_end_matches('/').ends_with(".map") {
        return not_found_fallback().await.into_response();
    }
    let hashed = path.starts_with("/assets/");
    let mut res = next.run(req).await;
    let ok = res.status().is_success() || res.status() == axum::http::StatusCode::NOT_MODIFIED;
    let cache = match (hashed, ok) {
        (true, true) => SPA_ASSET_CACHE_CONTROL,
        (true, false) => "no-store",
        (false, _) => "no-cache",
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    // Also on 304s and small files, which the compression layer doesn't mark.
    if !h.contains_key(header::VARY) {
        h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    res
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .nest(
            "/api",
            api_router().layer(api_cors(&state.config.cors_origins)),
        )
        .merge(public_router(&state).layer(public_cors()));

    app = match &state.config.web_dist {
        Some(dir) => app.fallback_service(spa_router(dir)),
        None => app.fallback(not_found_fallback),
    };

    // Log method + path only (never the query string, which may carry a preview token).
    let trace = TraceLayer::new_for_http().make_span_with(|req: &Request| {
        tracing::info_span!("http", method = %req.method(), path = %req.uri().path())
    });

    app.layer(trace).with_state(state)
}
