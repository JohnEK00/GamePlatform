//! Pixelforge Arcade desktop shell: hosts the @webgame/ui frontend in a Tauri webview.
//!
//! File access is limited to files the user explicitly picks in a native dialog opened *by Rust*:
//! `pick_file` shows the dialog, reads the chosen file and hands the frontend a one-time ticket;
//! `read_picked` exchanges that ticket for the bytes. The webview never supplies a filesystem path.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Largest file the frontend may read (game bundles are capped well below this server-side).
const MAX_READ_BYTES: u64 = 60 * 1024 * 1024;
/// Picked-but-unread files kept in memory at most (oldest is dropped first).
const MAX_PENDING: usize = 4;
const MAX_FILTERS: usize = 8;
const MAX_EXTENSIONS: usize = 32;

/// A dialog filter as sent by the frontend (`{ name, extensions }`).
#[derive(Debug, Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// Metadata returned by `pick_file`; the bytes are fetched with `read_picked(ticket)`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    ticket: String,
    name: String,
    size: u64,
}

struct Pending {
    bytes: Vec<u8>,
    created: Instant,
}

/// One-time tickets for files the user picked and the app already read.
#[derive(Default)]
struct PickedFiles(Mutex<HashMap<String, Pending>>);

impl PickedFiles {
    fn insert(&self, bytes: Vec<u8>) -> String {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        while map.len() >= MAX_PENDING {
            let oldest = map.iter().min_by_key(|(_, p)| p.created).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => map.remove(&k),
                None => break,
            };
        }
        let mut ticket = new_ticket();
        while map.contains_key(&ticket) {
            ticket = new_ticket();
        }
        map.insert(ticket.clone(), Pending { bytes, created: Instant::now() });
        ticket
    }

    /// Removes and returns the bytes for `ticket` (each ticket works once).
    fn take(&self, ticket: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(ticket).map(|p| p.bytes)
    }
}

/// Unpredictable 128-bit hex id (std's per-instance randomly keyed SipHash; no extra crates).
fn new_ticket() -> String {
    let part = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", part(), part())
}

/// Keeps only plain alphanumeric extensions (`"zip"`, `".PNG"` → `"png"`) and bounds the counts.
fn sanitize_filters(filters: Vec<DialogFilter>) -> Vec<(String, Vec<String>)> {
    filters
        .into_iter()
        .take(MAX_FILTERS)
        .filter_map(|f| {
            let exts: Vec<String> = f
                .extensions
                .iter()
                .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|e| !e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric()))
                .take(MAX_EXTENSIONS)
                .collect();
            if exts.is_empty() {
                return None;
            }
            let name: String = f.name.chars().filter(|c| !c.is_control()).take(64).collect();
            Some((if name.trim().is_empty() { "Files".into() } else { name }, exts))
        })
        .collect()
}

/// Opens the native open-file dialog, reads the chosen file (regular file, max 60 MB) and returns
/// its name, size and a one-time ticket. `None` when the user cancels.
#[tauri::command]
async fn pick_file(
    window: tauri::Window,
    picked: State<'_, PickedFiles>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<PickedFile>, String> {
    let filters = sanitize_filters(filters.unwrap_or_default());
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Option<(String, Vec<u8>)>, String> {
        let mut builder = window.dialog().file().set_parent(&window);
        for (name, exts) in &filters {
            let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
            builder = builder.add_filter(name.as_str(), &refs);
        }
        // Blocking is fine here: this runs on a worker thread, not the main/event-loop thread.
        let Some(choice) = builder.blocking_pick_file() else {
            return Ok(None);
        };
        let path = choice.into_path().map_err(|e| format!("unsupported file location: {e}"))?;
        let bytes = read_limited(&path)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        Ok(Some((name, bytes)))
    })
    .await
    .map_err(|e| format!("file picker task failed: {e}"))??;

    Ok(result.map(|(name, bytes)| {
        let size = bytes.len() as u64;
        PickedFile { ticket: picked.insert(bytes), name, size }
    }))
}

/// Returns the bytes for a ticket from `pick_file` and invalidates it. Sent as `tauri::ipc::Response`
/// so the webview receives an `ArrayBuffer` instead of a JSON number array.
#[tauri::command]
fn read_picked(picked: State<'_, PickedFiles>, ticket: String) -> Result<Response, String> {
    picked
        .take(&ticket)
        .map(Response::new)
        .ok_or_else(|| "unknown or already used file ticket".into())
}

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot open file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file is too large ({:.1} MB, max {} MB)",
            meta.len() as f64 / 1_048_576.0,
            MAX_READ_BYTES / 1_048_576
        ));
    }
    let file = File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    // `take` guards against the file growing between the size check and the read.
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read file: {e}"))?;
    if buf.len() as u64 > MAX_READ_BYTES {
        return Err(format!("file is too large (max {} MB)", MAX_READ_BYTES / 1_048_576));
    }
    Ok(buf)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(PickedFiles::default())
        .invoke_handler(tauri::generate_handler![pick_file, read_picked])
        .run(tauri::generate_context!())
        .expect("error while running Pixelforge Arcade");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn rejects_relative_missing_and_directory_paths() {
        assert!(read_limited(Path::new("relative.zip")).is_err());
        let missing = std::env::temp_dir().join("pixelforge-definitely-missing.zip");
        assert!(read_limited(&missing).is_err());
        assert_eq!(read_limited(&std::env::temp_dir()).unwrap_err(), "not a regular file");
    }

    #[test]
    fn reads_small_file() {
        let p: PathBuf = std::env::temp_dir().join(format!("pixelforge-read-test-{}.bin", std::process::id()));
        std::fs::write(&p, b"hello").unwrap();
        assert_eq!(read_limited(&p).unwrap(), b"hello");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn tickets_are_single_use_and_unguessable() {
        let store = PickedFiles::default();
        let t = store.insert(b"abc".to_vec());
        assert_eq!(t.len(), 32);
        assert!(store.take("not-a-ticket").is_none());
        assert_eq!(store.take(&t).unwrap(), b"abc");
        assert!(store.take(&t).is_none(), "ticket must be consumed");
        assert_ne!(new_ticket(), new_ticket());
    }

    #[test]
    fn pending_files_are_bounded() {
        let store = PickedFiles::default();
        let first = store.insert(vec![1]);
        let rest: Vec<String> = (0..MAX_PENDING).map(|i| store.insert(vec![i as u8])).collect();
        assert!(store.take(&first).is_none(), "oldest pending file is evicted");
        assert_eq!(store.0.lock().unwrap().len(), MAX_PENDING);
        assert!(rest.iter().all(|t| store.take(t).is_some()));
    }

    #[test]
    fn filters_are_sanitized() {
        let f = sanitize_filters(vec![
            DialogFilter { name: "Bundle".into(), extensions: vec![".ZIP".into(), "../x".into(), "*".into(), "".into()] },
            DialogFilter { name: "Bad".into(), extensions: vec!["a/b".into()] },
            DialogFilter { name: " ".into(), extensions: vec!["png".into()] },
        ]);
        assert_eq!(f, vec![("Bundle".to_string(), vec!["zip".to_string()]), ("Files".to_string(), vec!["png".to_string()])]);
    }
}
