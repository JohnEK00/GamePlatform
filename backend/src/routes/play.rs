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

/// Studio player page (docs/GAME_FORMAT.md "Studio protocol"): loads the engine, posts
/// `webgame:studio-ready`, waits for `webgame:studio-load` from `window.parent`, imports the
/// entry from a blob URL and boots with the in-memory `files`.
pub fn render_studio_html(origin: &str) -> String {
    let origin = js_string_content(origin);
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}canvas{{display:block;margin:auto}}</style>
</head><body><canvas id="game"></canvas>
<script type="module">
  const post = (msg) => {{ try {{ window.parent.postMessage(msg, "*"); }} catch (_) {{}} }};
  const toInt = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined);
  // blob: URL -> bundle-relative path, for error attribution.
  const urlToFile = new Map();
  const reportError = (stage, err, pos) => {{
    const msg = {{ type: "webgame:error", message: stage + ": " + String((err && err.message) || err || "unknown error") }};
    let file = (pos && pos.file) || (err && typeof err.file === "string" ? err.file : undefined);
    let line = pos && toInt(pos.line), column = pos && toInt(pos.column);
    if (line === undefined && err) {{ line = toInt(err.lineNumber); column = toInt(err.columnNumber); }}
    if (line === undefined && err && typeof err.stack === "string") {{
      const m = /(blob:[^\s)]*?):(\d+):(\d+)/.exec(err.stack);
      if (m) {{ line = Number(m[2]); column = Number(m[3]); file = file || urlToFile.get(m[1]); }}
    }}
    if (file !== undefined) msg.file = file;
    if (line !== undefined) msg.line = line;
    if (column !== undefined) msg.column = column;
    post(msg);
  }};
  // Module linker (GAME_FORMAT.md "Studio multi-file modules"): every JS module reachable
  // from the entry gets a blob: URL; relative specifiers in static/dynamic imports and
  // re-exports are rewritten to the dependency's blob URL, dependencies first.
  const SPEC = /(?<![\w$.])(import\s*\(\s*|from\s*|import\s*)(["'])([^"'\r\n]*)\2/g;
  const isJs = (p) => /\.m?js$/i.test(p);
  const resolveSpec = (from, spec) => {{
    const parts = from.split("/");
    parts.pop();
    for (const seg of spec.split("/")) {{
      if (seg === "..") {{ if (!parts.length) return null; parts.pop(); }}
      else if (seg !== "." && seg !== "") parts.push(seg);
    }}
    return parts.join("/");
  }};
  const linkModules = (files, entry) => {{
    const urls = new Map(), state = new Map(), stack = [];
    const fail = (file, message) => {{ const e = new Error(message); e.file = file; throw e; }};
    const visit = (file) => {{
      if (state.get(file) === 2) return urls.get(file);
      if (state.get(file) === 1) {{
        const cycle = stack.slice(stack.indexOf(file)).concat(file).join(" -> ");
        fail(stack[stack.length - 1], "Import cycle " + cycle + " (cyclic imports cannot run in the Studio preview)");
      }}
      state.set(file, 1);
      stack.push(file);
      const src = String(files[file]).replace(new RegExp(SPEC.source, "g"), (m, kw, q, spec) => {{
        if (!spec.startsWith("./") && !spec.startsWith("../")) return m;
        const target = resolveSpec(file, spec.replace(/[?#].*$/, ""));
        if (target === null) fail(file, "Import '" + spec + "' points outside the project");
        if (typeof files[target] !== "string" || !isJs(target)) {{
          fail(file, "Import '" + spec + "' not found: no JavaScript file '" + target + "' in the project");
        }}
        return kw + q + visit(target) + q;
      }});
      stack.pop();
      state.set(file, 2);
      const url = URL.createObjectURL(new Blob([src], {{ type: "text/javascript" }}));
      urls.set(file, url);
      urlToFile.set(url, file);
      return url;
    }};
    return visit(entry);
  }};
  let boot;
  try {{
    ({{ boot }} = await import("{origin}/runtime/engine.js"));
  }} catch (err) {{
    reportError("Failed to load engine", err);
  }}
  if (boot) {{
    let started = false;
    window.addEventListener("message", async (event) => {{
      if (event.source !== window.parent) return;
      const d = event.data;
      if (!d || d.type !== "webgame:studio-load" || started) return;
      started = true;
      const manifest = d.manifest || {{}};
      const files = d.files && typeof d.files === "object" ? d.files : {{}};
      const entry = typeof manifest.entry === "string" ? manifest.entry.replace(/^\.\//, "") : "";
      // Bundle-relative keys without a leading "./".
      const sources = {{}};
      for (const [k, v] of Object.entries(files)) {{
        if (typeof v === "string") sources[k.replace(/^\.\//, "")] = v;
      }}
      if (!entry || sources[entry] === undefined) {{
        reportError("Invalid project", new Error("manifest.entry '" + entry + "' is not in files"));
        return;
      }}
      let url;
      try {{
        url = linkModules(sources, entry);
      }} catch (err) {{
        reportError("Failed to load " + entry, err);
        return;
      }}
      let pos;
      const onError = (e) => {{
        const file = e && urlToFile.get(e.filename);
        if (file && !pos) pos = {{ file, line: e.lineno, column: e.colno }};
      }};
      window.addEventListener("error", onError);
      let mod;
      try {{
        mod = await import(url);
      }} catch (err) {{
        reportError("Failed to load " + entry, err, pos);
        return;
      }} finally {{
        window.removeEventListener("error", onError);
      }}
      const num = (v, dflt) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
      try {{
        await boot(document.getElementById("game"), mod.default, {{
          width: num(manifest.width, 800), height: num(manifest.height, 600), baseUrl: "about:blank", files,
        }});
      }} catch (err) {{
        // boot() already posted webgame:error before rethrowing; don't report it twice.
        console.error(err);
      }}
    }});
    post({{ type: "webgame:studio-ready" }});
  }}
</script></body></html>
"#
    )
}

fn page_origin(state: &AppState, headers: &HeaderMap) -> AppResult<String> {
    match &state.config.public_origin {
        Some(o) => Ok(o.clone()),
        None => request_origin(headers, state.config.port),
    }
}

fn player_response(origin: &str, html: String) -> AppResult<Response> {
    let csp = HeaderValue::from_str(&player_csp(origin))
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

/// GET /play/studio
pub async fn studio_page(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let origin = page_origin(&state, &headers)?;
    player_response(&origin, render_studio_html(&origin))
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
    let origin = page_origin(&state, &headers)?;
    let html = render_player_html(
        &origin,
        &game.id,
        &game.entry,
        game.version,
        game.width,
        game.height,
    );
    player_response(&origin, html)
}
