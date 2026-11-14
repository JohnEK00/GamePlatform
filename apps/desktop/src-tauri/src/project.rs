//! "Open local game folder": Rust shows a native folder dialog, reads the chosen folder with the same limits
//! and validation as bundle uploads (docs/GAME_FORMAT.md) and hands the webview an index plus a one-time
//! ticket. Text files are inlined in the index; binary files are fetched one by one with
//! `read_project_file(ticket, path)` (raw bytes, each file once). The webview never supplies a filesystem path.
//!
//! F013: every picked folder is remembered in `ProjectFolders` under a random, session-scoped `folderId`
//! (never the path), so `reload_project_folder(folderId)` can re-read it without a dialog. The registry is
//! the allowlist of folders the webview may re-read; it is in memory only and bounded (LRU).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::new_ticket;

/// Bundle file extensions accepted by the backend (backend/src/bundle.rs `ALLOWED_EXTS`).
pub const ALLOWED_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "svg", "json", "txt", "wav", "mp3", "ogg", "js", "css", "woff2", "ttf",
];
/// Extensions sent to the Studio as strings (everything else is an ArrayBuffer).
pub const TEXT_EXTS: &[&str] = &["js", "json", "txt", "css", "svg", "md", "csv"];
/// Unread projects kept in memory at most (oldest is dropped first).
const MAX_PENDING_PROJECTS: usize = 2;
/// Unread binary files are dropped after this long.
const PROJECT_TTL: Duration = Duration::from_secs(5 * 60);
/// At most this many skipped paths are listed by name (the total count is always reported).
const MAX_SKIPPED_LISTED: usize = 50;
/// Picked folders remembered for "Reload folder" at most (least recently used is dropped first).
const MAX_FOLDERS: usize = 16;
/// Error for an unknown folder id or a folder that was moved or deleted. The Studio matches "no longer available".
pub const FOLDER_GONE: &str = "The folder is no longer available. Open it again.";

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_depth: usize,
}

impl Limits {
    /// Same limits as uploads: ≤ 2000 files, ≤ 200 MB uncompressed.
    pub const UPLOAD: Limits = Limits { max_files: 2000, max_total_bytes: 200 * 1024 * 1024, max_depth: 32 };
}

/// A folder read from disk. `files` excludes game.json; paths are bundle-relative with `/` separators.
#[derive(Debug)]
pub struct ProjectData {
    /// Canonical project root (after the single-wrapper resolution). Never sent to the webview.
    pub root: PathBuf,
    pub folder: String,
    pub manifest: Value,
    pub files: Vec<(String, Vec<u8>)>,
    pub skipped: Vec<String>,
}

fn extension(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Entries skipped silently: dotfiles/dot-folders, macOS resource forks and Windows shell metadata.
fn is_ignored(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("__MACOSX")
        || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
}

/// Visible (non-ignored) entries of a directory, sorted by name.
fn list_dir(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot read folder: {e}"))? {
        let entry = entry.map_err(|e| format!("cannot read folder: {e}"))?;
        if !entry.file_name().to_str().is_some_and(is_ignored) {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

fn is_real_dir(entry: &fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)
}

/// Like uploads, a folder that only wraps the project in one top-level folder is accepted:
/// without a game.json at the root, a root holding exactly one sub-folder (and nothing else) descends into it.
fn project_root(root: &Path) -> Result<PathBuf, String> {
    if root.join("game.json").is_file() {
        return Ok(root.to_path_buf());
    }
    let entries = list_dir(root)?;
    if entries.len() == 1 && is_real_dir(&entries[0]) && entries[0].path().join("game.json").is_file() {
        return Ok(entries[0].path());
    }
    Ok(root.to_path_buf())
}

struct Walk<'a> {
    root: &'a Path,
    limits: Limits,
    count: usize,
    total: u64,
    manifest: Option<Value>,
    files: Vec<(String, Vec<u8>)>,
    skipped: Vec<String>,
}

impl Walk<'_> {
    fn walk(&mut self, dir: &Path, prefix: &str, depth: usize) -> Result<(), String> {
        if depth > self.limits.max_depth {
            return Err(format!("folders are nested too deeply (max {} levels)", self.limits.max_depth));
        }
        for entry in list_dir(dir)? {
            let os_name = entry.file_name();
            let Some(name) = os_name.to_str() else {
                self.skipped.push(format!("{prefix}{} (unsupported file name)", os_name.to_string_lossy()));
                continue;
            };
            let rel = format!("{prefix}{name}");
            if name.contains(['/', '\\']) || name == ".." {
                self.skipped.push(format!("{rel} (unsupported file name)"));
                continue;
            }
            // DirEntry::file_type does not follow links; on Windows `is_symlink` also covers junctions.
            let ft = entry.file_type().map_err(|e| format!("cannot read {rel}: {e}"))?;
            if ft.is_symlink() {
                self.skipped.push(format!("{rel} (symbolic link)"));
            } else if ft.is_dir() {
                self.walk(&entry.path(), &format!("{rel}/"), depth + 1)?;
            } else if ft.is_file() {
                self.file(&entry.path(), rel)?;
            } else {
                self.skipped.push(format!("{rel} (not a regular file)"));
            }
        }
        Ok(())
    }

    fn file(&mut self, path: &Path, rel: String) -> Result<(), String> {
        let is_manifest = rel == "game.json";
        if !is_manifest && !ALLOWED_EXTS.contains(&extension(&rel).as_str()) {
            self.skipped.push(rel);
            return Ok(());
        }
        // Defence in depth: the resolved path must still be inside the chosen folder.
        let real = path.canonicalize().map_err(|e| format!("cannot open {rel}: {e}"))?;
        if !real.starts_with(self.root) {
            return Err(format!("{rel} points outside the selected folder"));
        }
        self.count += 1;
        if self.count > self.limits.max_files {
            return Err(format!("the folder has too many files (max {})", self.limits.max_files));
        }
        let too_big = || {
            format!(
                "the folder is too large (max {} MB of game files)",
                self.limits.max_total_bytes / 1_048_576
            )
        };
        let remaining = self.limits.max_total_bytes - self.total;
        let meta = fs::symlink_metadata(path).map_err(|e| format!("cannot open {rel}: {e}"))?;
        if meta.len() > remaining {
            return Err(too_big());
        }
        let mut buf = Vec::with_capacity(meta.len() as usize);
        // `take` guards against the file growing between the size check and the read.
        File::open(path)
            .and_then(|f| f.take(remaining + 1).read_to_end(&mut buf))
            .map_err(|e| format!("cannot read {rel}: {e}"))?;
        if buf.len() as u64 > remaining {
            return Err(too_big());
        }
        self.total += buf.len() as u64;
        if is_manifest {
            let body = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
            let value: Value =
                serde_json::from_slice(body).map_err(|e| format!("game.json is not valid JSON: {e}"))?;
            if !value.is_object() {
                return Err("game.json must contain a JSON object".into());
            }
            self.manifest = Some(value);
        } else {
            self.files.push((rel, buf));
        }
        Ok(())
    }
}

/// Reads a game folder (see module docs). Errors are user-facing messages.
pub fn read_project_dir(dir: &Path, limits: Limits) -> Result<ProjectData, String> {
    if !dir.is_absolute() {
        return Err("path must be absolute".into());
    }
    let meta = fs::symlink_metadata(dir).map_err(|e| format!("cannot open folder: {e}"))?;
    if !meta.is_dir() {
        return Err("not a folder".into());
    }
    let root = project_root(&dir.canonicalize().map_err(|e| format!("cannot open folder: {e}"))?)?;
    let folder = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut walk = Walk {
        root: &root,
        limits,
        count: 0,
        total: 0,
        manifest: None,
        files: Vec::new(),
        skipped: Vec::new(),
    };
    walk.walk(&root, "", 0)?;
    let Walk { manifest, files, skipped, .. } = walk;
    let manifest = manifest.ok_or("No game.json found in the selected folder.")?;
    Ok(ProjectData { root, folder, manifest, files, skipped })
}

/// Decodes a text file like the browser's `File.text()` (UTF-8, BOM stripped, invalid bytes replaced).
fn decode_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).into_owned()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    path: String,
    size: u64,
    /// Present for text files; binary files are fetched with `read_project_file`.
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// Returned by `pick_project_folder` and `reload_project_folder`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndex {
    /// `None` when there are no non-empty binary files to fetch.
    ticket: Option<String>,
    /// Opaque, session-scoped handle for `reload_project_folder` (random, not derived from the path).
    folder_id: String,
    folder: String,
    manifest: Value,
    files: Vec<IndexEntry>,
    skipped: Vec<String>,
    skipped_count: usize,
}

struct PendingProject {
    files: HashMap<String, Vec<u8>>,
    created: Instant,
    /// Insertion order (timestamps can tie), used to evict the oldest project.
    seq: u64,
}

static NEXT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Binary files of opened projects, waiting to be fetched once each.
#[derive(Default)]
pub struct OpenProjects(Mutex<HashMap<String, PendingProject>>);

impl OpenProjects {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingProject>> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, p| p.created.elapsed() < PROJECT_TTL);
        map
    }

    pub fn insert(&self, files: HashMap<String, Vec<u8>>) -> String {
        let mut map = self.lock();
        while map.len() >= MAX_PENDING_PROJECTS {
            let oldest = map.iter().min_by_key(|(_, p)| p.seq).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => map.remove(&k),
                None => break,
            };
        }
        let mut ticket = new_ticket();
        while map.contains_key(&ticket) {
            ticket = new_ticket();
        }
        map.insert(ticket.clone(), PendingProject { files, created: Instant::now(), seq: NEXT_SEQ.fetch_add(1, Ordering::Relaxed) });
        ticket
    }

    /// Removes and returns one file; the ticket is dropped once its last file was taken.
    pub fn take_file(&self, ticket: &str, path: &str) -> Result<Vec<u8>, String> {
        let mut map = self.lock();
        let project = map.get_mut(ticket).ok_or("unknown or expired project ticket")?;
        let bytes = project.files.remove(path).ok_or("unknown or already read project file")?;
        if project.files.is_empty() {
            map.remove(ticket);
        }
        Ok(bytes)
    }

    pub fn release(&self, ticket: &str) {
        self.lock().remove(ticket);
    }
}

struct FolderEntry {
    root: PathBuf,
    /// Last use (registration or lookup), used to evict the least recently used folder.
    used: u64,
}

#[derive(Default)]
struct FolderMap {
    next: u64,
    map: HashMap<String, FolderEntry>,
}

/// Folders the user picked in this session, by random id. In memory only; at most `MAX_FOLDERS` (LRU).
#[derive(Default)]
pub struct ProjectFolders(Mutex<FolderMap>);

impl ProjectFolders {
    fn lock(&self) -> std::sync::MutexGuard<'_, FolderMap> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Remembers a canonical project root and returns a new random id (picking the same folder twice gives two ids).
    pub fn register(&self, root: PathBuf) -> String {
        let mut inner = self.lock();
        while inner.map.len() >= MAX_FOLDERS {
            let oldest = inner.map.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => inner.map.remove(&k),
                None => break,
            };
        }
        let mut id = new_ticket();
        while inner.map.contains_key(&id) {
            id = new_ticket();
        }
        inner.next += 1;
        let used = inner.next;
        inner.map.insert(id.clone(), FolderEntry { root, used });
        id
    }

    /// The root for `id`, marking it as recently used.
    pub fn get(&self, id: &str) -> Option<PathBuf> {
        let mut inner = self.lock();
        inner.next += 1;
        let used = inner.next;
        let entry = inner.map.get_mut(id)?;
        entry.used = used;
        Some(entry.root.clone())
    }

    pub fn forget(&self, id: &str) {
        self.lock().map.remove(id);
    }
}

/// Re-reads a registered folder with the same limits and validation as a pick. An unknown id, or a folder
/// that is gone or no longer a directory, gives `FOLDER_GONE` (and the id is forgotten).
fn reload_data(folders: &ProjectFolders, folder_id: &str) -> Result<ProjectData, String> {
    let root = folders.get(folder_id).ok_or(FOLDER_GONE)?;
    let gone = || !fs::metadata(&root).map(|m| m.is_dir()).unwrap_or(false);
    if gone() {
        folders.forget(folder_id);
        return Err(FOLDER_GONE.into());
    }
    read_project_dir(&root, Limits::UPLOAD).map_err(|e| {
        // It may have vanished during the read.
        if gone() {
            folders.forget(folder_id);
            FOLDER_GONE.into()
        } else {
            e
        }
    })
}

/// Splits a read folder into the JSON index (texts inline) and the binary files kept behind a ticket.
fn into_index(data: ProjectData, folder_id: String, projects: &OpenProjects) -> ProjectIndex {
    let mut entries = Vec::with_capacity(data.files.len());
    let mut binaries = HashMap::new();
    for (path, bytes) in data.files {
        let size = bytes.len() as u64;
        if TEXT_EXTS.contains(&extension(&path).as_str()) {
            entries.push(IndexEntry { path, size, text: Some(decode_text(&bytes)) });
        } else {
            if size > 0 {
                binaries.insert(path.clone(), bytes);
            }
            entries.push(IndexEntry { path, size, text: None });
        }
    }
    let skipped_count = data.skipped.len();
    ProjectIndex {
        ticket: (!binaries.is_empty()).then(|| projects.insert(binaries)),
        folder_id,
        folder: data.folder,
        manifest: data.manifest,
        files: entries,
        skipped: data.skipped.into_iter().take(MAX_SKIPPED_LISTED).collect(),
        skipped_count,
    }
}

/// Opens the native folder dialog and reads the chosen game folder. `None` when the user cancels.
#[tauri::command]
pub async fn pick_project_folder(
    window: tauri::Window,
    projects: State<'_, OpenProjects>,
    folders: State<'_, ProjectFolders>,
) -> Result<Option<ProjectIndex>, String> {
    let data = tauri::async_runtime::spawn_blocking(move || -> Result<Option<ProjectData>, String> {
        let choice = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open local game folder")
            .blocking_pick_folder();
        let Some(choice) = choice else {
            return Ok(None);
        };
        let path = choice.into_path().map_err(|e| format!("unsupported folder location: {e}"))?;
        read_project_dir(&path, Limits::UPLOAD).map(Some)
    })
    .await
    .map_err(|e| format!("folder picker task failed: {e}"))??;
    Ok(data.map(|d| {
        let id = folders.register(d.root.clone());
        into_index(d, id, &projects)
    }))
}

/// Re-reads a folder picked earlier in this session (no dialog). Returns a fresh index with a new ticket and
/// the same `folderId`. Errors with `FOLDER_GONE` for an unknown id or a folder that was moved or deleted.
#[tauri::command]
pub async fn reload_project_folder(app: tauri::AppHandle, folder_id: String) -> Result<Option<ProjectIndex>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = reload_data(&app.state::<ProjectFolders>(), &folder_id)?;
        Ok(Some(into_index(data, folder_id, &app.state::<OpenProjects>())))
    })
    .await
    .map_err(|e| format!("folder reload task failed: {e}"))?
}

/// Returns one binary file of an opened project as raw bytes (ArrayBuffer in the webview). Each file once.
#[tauri::command]
pub fn read_project_file(projects: State<'_, OpenProjects>, ticket: String, path: String) -> Result<Response, String> {
    projects.take_file(&ticket, &path).map(Response::new)
}

/// Drops the remaining files of a project (e.g. after a failed read).
#[tauri::command]
pub fn release_project(projects: State<'_, OpenProjects>, ticket: String) {
    projects.release(&ticket);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp directory removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("pixelforge-proj-{tag}-{}-{}", std::process::id(), new_ticket()));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn write(&self, rel: &str, data: &[u8]) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, data).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    const MANIFEST: &[u8] = br#"{"name":"T","entry":"main.js","width":320,"height":240}"#;

    fn paths(d: &ProjectData) -> Vec<&str> {
        d.files.iter().map(|(p, _)| p.as_str()).collect()
    }

    #[test]
    fn reads_project_and_skips_hidden_and_disallowed_files() {
        let t = TempDir::new("ok");
        t.write("game.json", MANIFEST);
        t.write("main.js", b"export default {};");
        t.write("assets/sprites/hero.png", &[0x89, b'P', b'N', b'G']);
        t.write("assets/readme.md", b"# notes");
        t.write("assets/tool.exe", b"MZ");
        t.write(".env", b"SECRET=1");
        t.write(".git/config", b"x");
        t.write("__MACOSX/main.js", b"junk");
        t.write("Thumbs.db", b"junk");
        let d = read_project_dir(&t.0, Limits::UPLOAD).unwrap();
        assert_eq!(d.manifest["entry"], "main.js");
        assert_eq!(paths(&d), vec!["assets/sprites/hero.png", "main.js"]);
        assert_eq!(d.skipped, vec!["assets/readme.md", "assets/tool.exe"]);
    }

    #[test]
    fn requires_valid_game_json_object() {
        let t = TempDir::new("manifest");
        t.write("main.js", b"");
        assert!(read_project_dir(&t.0, Limits::UPLOAD).unwrap_err().contains("No game.json"));
        t.write("game.json", b"{ nope");
        assert!(read_project_dir(&t.0, Limits::UPLOAD).unwrap_err().contains("not valid JSON"));
        t.write("game.json", b"[1, 2]");
        assert!(read_project_dir(&t.0, Limits::UPLOAD).unwrap_err().contains("JSON object"));
        t.write("game.json", b"\xEF\xBB\xBF{\"name\":\"bom\"}");
        assert_eq!(read_project_dir(&t.0, Limits::UPLOAD).unwrap().manifest["name"], "bom");
        // game.json must be at the project root, not in a sub-folder next to other files.
        let u = TempDir::new("nested-manifest");
        u.write("src/game.json", MANIFEST);
        u.write("other.txt", b"");
        assert!(read_project_dir(&u.0, Limits::UPLOAD).is_err());
    }

    #[test]
    fn descends_into_single_wrapper_folder() {
        let t = TempDir::new("wrap");
        t.write("my-game/game.json", MANIFEST);
        t.write("my-game/main.js", b"");
        t.write(".DS_Store", b"");
        let d = read_project_dir(&t.0, Limits::UPLOAD).unwrap();
        assert_eq!(d.folder, "my-game");
        assert_eq!(paths(&d), vec!["main.js"]);
    }

    #[test]
    fn enforces_file_count_size_and_depth_limits() {
        let t = TempDir::new("limits");
        t.write("game.json", MANIFEST);
        t.write("a.js", &[b'a'; 100]);
        t.write("b.js", &[b'b'; 100]);
        let small = |max_files, max_total_bytes, max_depth| Limits { max_files, max_total_bytes, max_depth };
        // game.json counts towards both limits, like in a zip.
        assert!(read_project_dir(&t.0, small(3, 10_000, 4)).is_ok());
        assert!(read_project_dir(&t.0, small(2, 10_000, 4)).unwrap_err().contains("too many files"));
        let total = MANIFEST.len() as u64 + 200;
        assert!(read_project_dir(&t.0, small(10, total, 4)).is_ok());
        assert!(read_project_dir(&t.0, small(10, total - 1, 4)).unwrap_err().contains("too large"));
        t.write("x/y/z/deep.js", b"");
        assert!(read_project_dir(&t.0, small(10, 10_000, 2)).unwrap_err().contains("nested too deeply"));
        assert!(read_project_dir(&t.0, small(10, 10_000, 3)).is_ok());
    }

    #[test]
    fn rejects_relative_and_non_folder_paths() {
        assert!(read_project_dir(Path::new("relative/dir"), Limits::UPLOAD).is_err());
        let t = TempDir::new("file");
        t.write("game.json", MANIFEST);
        assert_eq!(read_project_dir(&t.0.join("game.json"), Limits::UPLOAD).unwrap_err(), "not a folder");
    }

    #[test]
    fn does_not_follow_links_out_of_the_folder() {
        let outside = TempDir::new("outside");
        outside.write("secret.txt", b"secret");
        let t = TempDir::new("links");
        t.write("game.json", MANIFEST);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside.0, t.0.join("linked")).is_ok()
            && std::os::unix::fs::symlink(outside.0.join("secret.txt"), t.0.join("secret.txt")).is_ok();
        // Creating symlinks on Windows needs Developer Mode or admin rights; skip when unavailable.
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside.0, t.0.join("linked")).is_ok()
            && std::os::windows::fs::symlink_file(outside.0.join("secret.txt"), t.0.join("secret.txt")).is_ok();
        if !made {
            eprintln!("symlinks unavailable; skipping");
            return;
        }
        let d = read_project_dir(&t.0, Limits::UPLOAD).unwrap();
        assert!(d.files.is_empty(), "linked files must not be read");
        assert_eq!(d.skipped, vec!["linked (symbolic link)", "secret.txt (symbolic link)"]);
    }

    #[test]
    fn index_inlines_text_and_tickets_binaries_once() {
        let store = OpenProjects::default();
        let data = ProjectData {
            root: PathBuf::from("/g"),
            folder: "g".into(),
            manifest: serde_json::json!({ "entry": "main.js" }),
            files: vec![
                ("main.js".into(), b"\xEF\xBB\xBFlet x = 1;".to_vec()),
                ("a.png".into(), vec![1, 2, 3]),
                ("empty.wav".into(), vec![]),
            ],
            skipped: (0..60).map(|i| format!("f{i}.exe")).collect(),
        };
        let index = into_index(data, "id".into(), &store);
        assert_eq!(index.folder_id, "id");
        assert_eq!(index.files[0].text.as_deref(), Some("let x = 1;"));
        assert_eq!(index.files[1], IndexEntry { path: "a.png".into(), size: 3, text: None });
        assert_eq!(index.files[2].size, 0);
        assert_eq!((index.skipped.len(), index.skipped_count), (MAX_SKIPPED_LISTED, 60));
        let ticket = index.ticket.unwrap();
        assert!(store.take_file(&ticket, "main.js").is_err(), "text files are not stored");
        assert!(store.take_file(&ticket, "empty.wav").is_err(), "empty files are not stored");
        assert_eq!(store.take_file(&ticket, "a.png").unwrap(), vec![1, 2, 3]);
        assert!(store.take_file(&ticket, "a.png").is_err(), "ticket is gone after the last file");
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn project_store_is_bounded_and_releasable() {
        let store = OpenProjects::default();
        let files = || HashMap::from([("a.png".to_string(), vec![1u8])]);
        let first = store.insert(files());
        let second = store.insert(files());
        let third = store.insert(files());
        assert!(store.take_file(&first, "a.png").is_err(), "oldest project is evicted");
        store.release(&second);
        assert!(store.take_file(&second, "a.png").is_err());
        assert!(store.take_file(&third, "../a.png").is_err());
        assert!(store.take_file(&third, "a.png").is_ok());
    }

    #[test]
    fn folder_registry_is_bounded_lru_with_random_ids() {
        let folders = ProjectFolders::default();
        let a = folders.register(PathBuf::from("/a"));
        let a2 = folders.register(PathBuf::from("/a"));
        assert_ne!(a, a2, "ids are random, not derived from the path");
        assert_eq!(a.len(), 32);
        let others: Vec<String> = (2..MAX_FOLDERS).map(|i| folders.register(PathBuf::from(format!("/f{i}")))).collect();
        assert_eq!(folders.lock().map.len(), MAX_FOLDERS);
        // Touch `a`, so `a2` is now the least recently used.
        assert_eq!(folders.get(&a), Some(PathBuf::from("/a")));
        let newest = folders.register(PathBuf::from("/new"));
        assert_eq!(folders.lock().map.len(), MAX_FOLDERS);
        assert!(folders.get(&a2).is_none(), "LRU entry is evicted");
        assert!(folders.get(&a).is_some());
        assert!(folders.get(&newest).is_some());
        assert!(others.iter().all(|id| folders.get(id).is_some()));
    }

    #[test]
    fn reload_unknown_id_errors() {
        let folders = ProjectFolders::default();
        assert_eq!(reload_data(&folders, "nope").unwrap_err(), FOLDER_GONE);
        assert!(FOLDER_GONE.contains("no longer available"));
    }

    #[test]
    fn reload_reads_new_content_and_keeps_the_id() {
        let t = TempDir::new("reload");
        t.write("game.json", MANIFEST);
        t.write("main.js", b"v1");
        let folders = ProjectFolders::default();
        let projects = OpenProjects::default();
        let d = read_project_dir(&t.0, Limits::UPLOAD).unwrap();
        let id = folders.register(d.root.clone());
        t.write("main.js", b"v2");
        t.write("hero.png", &[1, 2]);
        let index = into_index(reload_data(&folders, &id).unwrap(), id.clone(), &projects);
        assert_eq!(index.folder_id, id);
        assert_eq!(index.files.iter().find(|f| f.path == "main.js").unwrap().text.as_deref(), Some("v2"));
        assert_eq!(projects.take_file(index.ticket.as_deref().unwrap(), "hero.png").unwrap(), vec![1, 2]);
        // Validation still applies: an invalid game.json is reported, and the folder stays registered.
        t.write("game.json", b"{ nope");
        assert!(reload_data(&folders, &id).unwrap_err().contains("not valid JSON"));
        assert!(folders.get(&id).is_some());
    }

    #[test]
    fn reload_after_deleting_the_folder_errors_and_forgets_the_id() {
        let t = TempDir::new("gone");
        t.write("wrapper/game.json", MANIFEST);
        let folders = ProjectFolders::default();
        let d = read_project_dir(&t.0, Limits::UPLOAD).unwrap();
        assert_eq!(d.folder, "wrapper");
        let id = folders.register(d.root.clone());
        fs::remove_dir_all(t.0.join("wrapper")).unwrap();
        assert_eq!(reload_data(&folders, &id).unwrap_err(), FOLDER_GONE);
        assert!(folders.get(&id).is_none(), "id is forgotten");
        // A file where the folder was is not a folder either.
        t.write("wrapper", b"x");
        let id = folders.register(t.0.join("wrapper"));
        assert_eq!(reload_data(&folders, &id).unwrap_err(), FOLDER_GONE);
    }
}
