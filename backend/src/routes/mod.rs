//! Router assembly: `/api` (strict CORS) + public hosting routes (`*` CORS).

pub mod achievements;
pub mod auth;
pub mod comments;
pub mod favorites;
pub mod files;
pub mod games;
pub mod play;
pub mod reports;
pub mod saves;
pub mod scores;
pub mod stats;
pub mod tags;
pub mod users;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{HeaderValue, Method, header};
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
            put(games::upload_bundle).layer(upload_limit),
        )
        .route(
            "/games/{id}/thumbnail",
            put(games::upload_thumbnail).layer(image_limit),
        )
        .route("/games/{id}/play", post(games::record_play))
        .route("/games/{id}/preview-token", post(games::preview_token))
        .route(
            "/games/{id}/rating",
            put(games::put_rating).delete(games::delete_rating),
        )
        .route(
            "/games/{id}/comments",
            get(comments::list_comments).post(comments::create_comment),
        )
        .route("/comments/{id}", delete(comments::delete_comment))
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
        .route("/runtime/{*path}", get(files::runtime_file))
        .route("/games/{id}/files/{*path}", get(files::game_file))
        .nest_service(
            "/media/thumbnails",
            ServeDir::new(state.storage.thumbnails_dir()),
        )
        .nest_service("/media/avatars", ServeDir::new(state.storage.avatars_dir()))
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
        .expose_headers([header::RETRY_AFTER])
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

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .nest(
            "/api",
            api_router().layer(api_cors(&state.config.cors_origins)),
        )
        .merge(public_router(&state).layer(public_cors()));

    app = match &state.config.web_dist {
        Some(dir) => {
            let index = dir.join("index.html");
            app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        None => app.fallback(not_found_fallback),
    };

    // Log method + path only (never the query string, which may carry a preview token).
    let trace = TraceLayer::new_for_http().make_span_with(|req: &Request| {
        tracing::info_span!("http", method = %req.method(), path = %req.uri().path())
    });

    app.layer(trace).with_state(state)
}
