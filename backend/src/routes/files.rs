//! Static hosting: `/runtime/*` (engine build) and `/games/{id}/files/*` (bundle files).

use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::extract::ApiPath;
use crate::routes::games::fetch_game_row;

/// MIME type for a file path; JavaScript is always `text/javascript`.
pub fn mime_for(path: &str) -> String {
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let m = match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => {
            return mime_guess::from_ext(&ext)
                .first_raw()
                .unwrap_or("application/octet-stream")
                .to_string();
        }
    };
    m.to_string()
}

/// Join a URL path onto `base`, rejecting traversal and odd components.
pub fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    let mut any = false;
    for part in rel.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\\')
            || part.contains(':')
            || part.contains('\0')
        {
            return None;
        }
        out.push(part);
        any = true;
    }
    any.then_some(out)
}

async fn serve_file(path: &Path, rel: &str) -> AppResult<Response> {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => {}
        _ => return Err(AppError::not_found("File")),
    }
    let bytes = tokio::fs::read(path).await?;
    let ct = HeaderValue::from_str(&mime_for(rel))
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    Ok((
        [
            (header::CONTENT_TYPE, ct),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            // If a file (e.g. an SVG) is opened top-level, keep it in an opaque origin.
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            ),
        ],
        bytes,
    )
        .into_response())
}

pub async fn runtime_file(
    State(state): State<AppState>,
    ApiPath(path): ApiPath<String>,
) -> AppResult<Response> {
    let dist = &state.config.engine_dist;
    let target = safe_join(dist, &path).ok_or_else(|| AppError::not_found("File"))?;
    if path == "engine.js" && !tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Err(AppError::ServiceUnavailable(format!(
            "Engine runtime not found at {}. Build it with `npm run build:engine` from the repo \
             root, or set ENGINE_DIST to the directory containing engine.js.",
            target.display()
        )));
    }
    serve_file(&target, &path).await
}

pub async fn game_file(
    State(state): State<AppState>,
    ApiPath((id, path)): ApiPath<(String, String)>,
) -> AppResult<Response> {
    // Files are served for unpublished games too: the owner-preview player page loads them
    // from an opaque origin without credentials, and game ids are unguessable UUIDs.
    let game = fetch_game_row(&state, &id)
        .await?
        .ok_or_else(|| AppError::not_found("Game"))?;
    let base = state.storage.version_dir(&game.id, game.version);
    let target = safe_join(&base, &path).ok_or_else(|| AppError::not_found("File"))?;
    serve_file(&target, &path).await
}
