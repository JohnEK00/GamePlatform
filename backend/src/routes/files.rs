//! Static hosting: `/runtime/*` (engine build) and `/games/{id}/files/*` (bundle files).

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::extract::ApiPath;
use crate::routes::games::fetch_game_row;
use tokio_util::io::ReaderStream;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{And, Predicate, SizeAbove};

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
        "fnt" => "text/plain; charset=utf-8",
        _ => {
            return mime_guess::from_ext(&ext)
                .first_raw()
                .unwrap_or("application/octet-stream")
                .to_string();
        }
    };
    m.to_string()
}

/// Review 5 M1: content types worth gzipping (text, JSON, JS, SVG, XML, wasm). Media that is
/// already compressed (png/jpeg/webp/gif, mp3/ogg, woff2, zip) is never recompressed.
pub fn compressible(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("text/")
        || matches!(
            essence.as_str(),
            "application/json"
                | "application/javascript"
                | "application/xml"
                | "application/manifest+json"
                | "application/wasm"
                | "image/svg+xml"
        )
}

/// Smallest response body that is compressed (smaller ones gain nothing).
pub const COMPRESS_MIN_BYTES: u16 = 256;

/// Compress successful responses with a [`compressible`] `Content-Type` and a body of at least
/// [`COMPRESS_MIN_BYTES`].
#[derive(Clone, Copy, Debug, Default)]
pub struct TextOnly;

impl Predicate for TextOnly {
    fn should_compress<B>(&self, response: &axum::http::Response<B>) -> bool
    where
        B: axum::body::HttpBody,
    {
        response.status() == StatusCode::OK
            && response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(compressible)
    }
}

/// Review 5 M1: gzip for text responses (SPA, `/runtime/*`, game files), negotiated with
/// `Accept-Encoding`. It adds `Vary: Accept-Encoding` and drops `Content-Length` when it
/// compresses. Not used on `/api` (responses there can mix secrets with reflected input).
pub fn compression() -> CompressionLayer<And<TextOnly, SizeAbove>> {
    CompressionLayer::new()
        .gzip(true)
        .compress_when(TextOnly.and(SizeAbove::new(COMPRESS_MIN_BYTES)))
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

/// Strong validator for a file: `"{tag}-{size}-{mtime}"` (mtime in ns since the epoch).
/// `tag` is `v{version}` for game files, `rt` for the engine runtime.
pub fn etag_for(tag: &str, meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("\"{tag}-{}-{mtime}\"", meta.len())
}

/// `If-None-Match` matches `etag` (weak comparison, as RFC 9110 requires for this header).
fn none_match(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t == "*" || t.strip_prefix("W/").unwrap_or(t) == etag)
}

async fn serve_file(path: &Path, rel: &str, tag: &str, headers: &HeaderMap) -> AppResult<Response> {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m,
        _ => return Err(AppError::not_found("File")),
    };
    let etag = etag_for(tag, &meta);
    let mime = mime_for(rel);
    // Review 5 M1: a compressible file may be sent gzipped by [`compression`], so its
    // validator is weak (the gzip bytes differ from the file) and caches key it on
    // `Accept-Encoding`. Both apply to 200 and 304 alike. Media keeps a strong ETag.
    let compress = compressible(&mime);
    let etag_header = if compress {
        format!("W/{etag}")
    } else {
        etag.clone()
    };
    let mut common = HeaderMap::new();
    common.insert(
        header::ETAG,
        HeaderValue::from_str(&etag_header)
            .map_err(|e| AppError::Internal(format!("etag: {e}")))?,
    );
    if compress {
        common.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    // Always revalidate; the ETag makes that a cheap 304.
    common.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    common.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // If a file (e.g. an SVG) is opened top-level, keep it in an opaque origin.
    common.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    if none_match(headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, common).into_response());
    }
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::not_found("File"));
        }
        Err(e) => return Err(e.into()),
    };
    let ct = HeaderValue::from_str(&mime)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    // Streamed: large assets are never buffered whole in memory.
    let body = Body::from_stream(ReaderStream::new(file));
    Ok((
        common,
        [
            (header::CONTENT_TYPE, ct),
            (header::CONTENT_LENGTH, HeaderValue::from(meta.len())),
        ],
        body,
    )
        .into_response())
}

pub async fn runtime_file(
    State(state): State<AppState>,
    headers: HeaderMap,
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
    serve_file(&target, &path, "rt", &headers).await
}

pub async fn game_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath((id, path)): ApiPath<(String, String)>,
) -> AppResult<Response> {
    // Files are served for unpublished games too: the owner-preview player page loads them
    // from an opaque origin without credentials, and game ids are unguessable UUIDs.
    let game = fetch_game_row(&state, &id)
        .await?
        .ok_or_else(|| AppError::not_found("Game"))?;
    let base = state.storage.version_dir(&game.id, game.version);
    let target = safe_join(&base, &path).ok_or_else(|| AppError::not_found("File"))?;
    serve_file(&target, &path, &format!("v{}", game.version), &headers).await
}
