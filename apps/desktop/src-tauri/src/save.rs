//! Native "Save as": the webview sends the file as a raw IPC body (no JSON number array) with the suggested
//! name percent-encoded in the `x-file-name` header. Rust shows the save dialog and writes only to the path
//! the user picked there.

use std::path::Path;

use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

/// Largest file the webview may save (Studio exports are capped at 50 MB by the backend anyway).
pub const MAX_SAVE_BYTES: usize = 100 * 1024 * 1024;
pub const FILE_NAME_HEADER: &str = "x-file-name";

/// Decodes `encodeURIComponent` output. `None` for malformed escapes or invalid UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Reduces a suggested name to a safe bare file name (no directories, reserved or control characters).
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .take(128)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned.into()
    }
}

/// Lower-case alphanumeric extension of a file name, if any.
pub fn file_extension(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric())).then_some(ext)
}

/// Shows the native save dialog (filtered by the suggested name's extension) and writes the request body
/// to the chosen file. `false` when the user cancels.
#[tauri::command]
pub async fn save_file(window: tauri::Window, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("save_file expects a raw binary body".into());
    };
    if body.len() > MAX_SAVE_BYTES {
        return Err(format!("file is too large to save (max {} MB)", MAX_SAVE_BYTES / 1_048_576));
    }
    let suggested = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .unwrap_or_default();
    let name = sanitize_file_name(&suggested);
    let bytes = body.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let mut builder = window.dialog().file().set_parent(&window).set_file_name(&name);
        if let Some(ext) = file_extension(&name) {
            builder = builder.add_filter(format!("{} file", ext.to_ascii_uppercase()), &[ext.as_str()]);
        }
        // Blocking is fine here: this runs on a worker thread, not the main/event-loop thread.
        let Some(choice) = builder.blocking_save_file() else {
            return Ok(false);
        };
        let path = choice.into_path().map_err(|e| format!("unsupported save location: {e}"))?;
        if !path.is_absolute() {
            return Err("save path must be absolute".into());
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("cannot save file: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("save dialog task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_encode_uri_component() {
        assert_eq!(percent_decode("my%20game%20%C3%A9.zip").as_deref(), Some("my game é.zip"));
        assert_eq!(percent_decode("plain.zip").as_deref(), Some("plain.zip"));
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_decode("bad%zz"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name("space-dodge.zip"), "space-dodge.zip");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("a<b>:c?.zip\u{0}"), "abc.zip");
        assert_eq!(sanitize_file_name(" .. "), "download");
        assert_eq!(sanitize_file_name(""), "download");
        assert_eq!(sanitize_file_name(&"x".repeat(300)).len(), 128);
    }

    #[test]
    fn extracts_extensions() {
        assert_eq!(file_extension("game.ZIP").as_deref(), Some("zip"));
        assert_eq!(file_extension("noext"), None);
        assert_eq!(file_extension("weird.z!p"), None);
    }
}
