//! GET /play/{id}: the player HTML page (template from docs/GAME_FORMAT.md).

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::AppState;
use crate::auth::verify_preview_token;
use crate::error::{AppError, AppResult};
use crate::extract::{ApiPath, ApiQuery};
use crate::routes::games::fetch_game_row;

#[derive(Deserialize)]
pub struct PlayQuery {
    pub token: Option<String>,
}

/// Absolute origin of this backend as seen by the client (`Host` + `X-Forwarded-Proto`).
pub fn request_origin(headers: &HeaderMap, fallback_port: u16) -> AppResult<String> {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| v == "http" || v == "https")
        .unwrap_or_else(|| "http".to_string());
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("localhost:{fallback_port}"));
    let valid = host.len() <= 255
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '_'));
    if !valid {
        return Err(AppError::BadRequest("Invalid Host header".into()));
    }
    Ok(format!("{proto}://{host}"))
}

/// Escape a value for interpolation inside a double-quoted JS string in an HTML `<script>`.
pub fn js_string_content(s: &str) -> String {
    let quoted = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    quoted[1..quoted.len() - 1]
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Percent-encode a relative URL path, keeping `/` separators.
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn render_player_html(
    origin: &str,
    id: &str,
    entry: &str,
    version: i64,
    width: i64,
    height: i64,
) -> String {
    let origin = js_string_content(origin);
    let id = js_string_content(id);
    let entry = js_string_content(&encode_path(entry));
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}canvas{{display:block;margin:auto}}</style>
</head><body><canvas id="game"></canvas>
<script type="module">
  import {{ boot }} from "{origin}/runtime/engine.js";
  const base = "{origin}/games/{id}/files/";
  const mod = await import(base + "{entry}?v={version}");
  await boot(document.getElementById("game"), mod.default, {{ width: {width}, height: {height}, baseUrl: base }});
</script></body></html>
"#
    )
}

/// CSP for the player page. `sandbox` keeps untrusted game code in an opaque origin even if
/// the page is opened top-level (outside the app's sandboxed iframe).
pub fn player_csp(origin: &str) -> String {
    format!(
        "sandbox allow-scripts allow-pointer-lock; \
         default-src 'none'; \
         script-src {origin} 'unsafe-inline' 'unsafe-eval' blob:; \
         style-src {origin} 'unsafe-inline'; \
         img-src {origin} data: blob:; \
         media-src {origin} data: blob:; \
         font-src {origin} data:; \
         connect-src {origin} data: blob:; \
         worker-src {origin} blob:; \
         base-uri 'none'; form-action 'none'"
    )
}

pub async fn play_page(
    State(state): State<AppState>,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PlayQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let game = fetch_game_row(&state, &id)
        .await?
        .ok_or_else(|| AppError::not_found("Game"))?;
    if !game.published {
        // Only a preview-scoped token minted for this game by its owner unlocks it;
        // session tokens never authenticate here.
        let viewer = query
            .token
            .as_deref()
            .filter(|t| !t.is_empty())
            .and_then(|t| verify_preview_token(&state.config.jwt_secret, t, &game.id));
        if viewer.as_deref() != Some(game.owner_id.as_str()) {
            return Err(AppError::not_found("Game"));
        }
    }
    let origin = match &state.config.public_origin {
        Some(o) => o.clone(),
        None => request_origin(&headers, state.config.port)?,
    };
    let html = render_player_html(
        &origin,
        &game.id,
        &game.entry,
        game.version,
        game.width,
        game.height,
    );
    let csp = HeaderValue::from_str(&player_csp(&origin))
        .map_err(|e| AppError::Internal(format!("csp header: {e}")))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (header::CONTENT_SECURITY_POLICY, csp),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
        ],
        html,
    )
        .into_response())
}
