//! Native "Save as": the webview sends the file as a raw IPC body (no JSON number array) with the suggested
//! name percent-encoded in the `x-file-name` header. Rust shows the save dialog and writes only to the path
//! the user picked there.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The folder of the last image saved in this session (in memory only), so repeated screenshot
/// downloads open where the previous one went.
#[derive(Default)]
pub struct LastImageDir(Mutex<Option<PathBuf>>);

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// The save dialog's starting folder: for image names, the last image folder used this session, else the
/// OS Pictures folder. `None` (no hint, the dialog's default) for other files or when neither is known.
pub fn image_save_dir(
    ext: Option<&str>,
    last: Option<&Path>,
    pictures: Option<&Path>,
) -> Option<PathBuf> {
    if !ext.is_some_and(|e| IMAGE_EXTENSIONS.contains(&e)) {
        return None;
    }
    last.or(pictures).map(Path::to_path_buf)
}

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
            let hex = s
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))?;
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
    (!ext.is_empty() && ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then_some(ext)
}

/// Shows the native save dialog (filtered by the suggested name's extension) and writes the request body
/// to the chosen file. `false` when the user cancels.
#[tauri::command]
pub async fn save_file(
    window: tauri::Window,
    request: Request<'_>,
    last_image_dir: State<'_, LastImageDir>,
) -> Result<bool, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("save_file expects a raw binary body".into());
    };
    if body.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "file is too large to save (max {} MB)",
            MAX_SAVE_BYTES / 1_048_576
        ));
    }
    let suggested = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .unwrap_or_default();
    let name = sanitize_file_name(&suggested);
    let bytes = body.clone();
    let ext = file_extension(&name);
    let is_image = ext
        .as_deref()
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e));
    let start_dir = if is_image {
        let last = last_image_dir
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let pictures = window
            .app_handle()
            .path()
            .picture_dir()
            .ok()
            .filter(|p| p.is_dir());
        image_save_dir(
            ext.as_deref(),
            last.as_deref().filter(|p| p.is_dir()),
            pictures.as_deref(),
        )
    } else {
        None
    };
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<Option<PathBuf>, String> {
        let mut builder = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&name);
        if let Some(dir) = start_dir {
            builder = builder.set_directory(dir);
        }
        if let Some(ext) = ext {
            builder = builder.add_filter(
                format!("{} file", ext.to_ascii_uppercase()),
                &[ext.as_str()],
            );
        }
        // Blocking is fine here: this runs on a worker thread, not the main/event-loop thread.
        let Some(choice) = builder.blocking_save_file() else {
            return Ok(None);
        };
        let path = choice
            .into_path()
            .map_err(|e| format!("unsupported save location: {e}"))?;
        if !path.is_absolute() {
            return Err("save path must be absolute".into());
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("cannot save file: {e}"))?;
        Ok(Some(path))
    })
    .await
    .map_err(|e| format!("save dialog task failed: {e}"))??;
    let Some(path) = saved else {
        return Ok(false);
    };
    if is_image {
        if let Some(dir) = path.parent() {
            *last_image_dir.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.to_path_buf());
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_encode_uri_component() {
        assert_eq!(
            percent_decode("my%20game%20%C3%A9.zip").as_deref(),
            Some("my game é.zip")
        );
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

    #[test]
    fn image_saves_start_in_last_dir_then_pictures() {
        let last = Path::new("/home/u/shots");
        let pics = Path::new("/home/u/Pictures");
        for ext in ["png", "jpg", "jpeg", "webp"] {
            assert_eq!(
                image_save_dir(Some(ext), Some(last), Some(pics)),
                Some(last.to_path_buf())
            );
            assert_eq!(
                image_save_dir(Some(ext), None, Some(pics)),
                Some(pics.to_path_buf())
            );
        }
        assert_eq!(image_save_dir(Some("png"), None, None), None);
    }

    #[test]
    fn non_images_get_no_directory_hint() {
        let last = Path::new("/home/u/shots");
        let pics = Path::new("/home/u/Pictures");
        assert_eq!(image_save_dir(Some("zip"), Some(last), Some(pics)), None);
        assert_eq!(image_save_dir(Some("gif"), Some(last), Some(pics)), None);
        assert_eq!(image_save_dir(None, Some(last), Some(pics)), None);
    }
}
