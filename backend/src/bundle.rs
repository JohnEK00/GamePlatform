//! Game bundle (.zip) validation and extraction. See docs/GAME_FORMAT.md.

use std::collections::HashSet;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde_json::Value;

use crate::error::AppError;

pub const MAX_COMPRESSED: usize = 50 * 1024 * 1024;
pub const MAX_UNCOMPRESSED: u64 = 200 * 1024 * 1024;
pub const MAX_FILES: usize = 2000;

pub const ALLOWED_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "svg", "json", "txt", "wav", "mp3", "ogg", "js", "css",
    "woff2", "ttf", "fnt",
];

pub const MAX_ACHIEVEMENTS: usize = 50;
pub const ACHIEVEMENT_ID_MAX: usize = 32;
pub const ACHIEVEMENT_NAME_MAX: usize = 60;
pub const ACHIEVEMENT_DESCRIPTION_MAX: usize = 200;
pub const ICON_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AchievementMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Normalised bundle-relative path (verified to exist in the bundle).
    pub icon: Option<String>,
}

pub const LEADERBOARD_LABEL_MAX: usize = 24;

/// The optional `leaderboard` block of game.json (GAME_FORMAT.md § F001), with defaults applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaderboardMeta {
    /// `"desc"` (higher is better) or `"asc"` (lower is better).
    pub order: String,
    /// `"number"` or `"time"` (milliseconds).
    pub format: String,
    /// Trimmed, 0-24 chars; `""` = UI default.
    pub label: String,
}

impl Default for LeaderboardMeta {
    fn default() -> Self {
        Self {
            order: "desc".into(),
            format: "number".into(),
            label: String::new(),
        }
    }
}

pub const MAX_ACTIONS: usize = 32;
pub const MAX_ACTION_KEYS: usize = 3;
pub const MAX_ACTION_GAMEPAD: usize = 2;
pub const ACTION_ID_MAX: usize = 32;
pub const ACTION_NAME_MAX: usize = 40;
pub const CONTROLS_HINT_MAX: usize = 300;

/// Bindable `KeyboardEvent.code` values plus mouse buttons (GAME_FORMAT.md § F009, normative):
/// 83 keyboard codes and 3 mouse codes.
pub const BINDABLE_KEYS: &[&str] = &[
    "KeyA",
    "KeyB",
    "KeyC",
    "KeyD",
    "KeyE",
    "KeyF",
    "KeyG",
    "KeyH",
    "KeyI",
    "KeyJ",
    "KeyK",
    "KeyL",
    "KeyM",
    "KeyN",
    "KeyO",
    "KeyP",
    "KeyQ",
    "KeyR",
    "KeyS",
    "KeyT",
    "KeyU",
    "KeyV",
    "KeyW",
    "KeyX",
    "KeyY",
    "KeyZ",
    "Digit0",
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Numpad0",
    "Numpad1",
    "Numpad2",
    "Numpad3",
    "Numpad4",
    "Numpad5",
    "Numpad6",
    "Numpad7",
    "Numpad8",
    "Numpad9",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
    "Enter",
    "Backspace",
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "Comma",
    "Period",
    "Slash",
    "IntlBackslash",
    "Insert",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Mouse0",
    "Mouse1",
    "Mouse2",
];

/// Gamepad button names (GAME_FORMAT.md § F009): the engine's `GamepadButtons` without `Home`.
pub const GAMEPAD_BUTTONS: &[&str] = &[
    "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left",
    "Right",
];

/// One declared action (GAME_FORMAT.md § F009), normalised. Serialised as-is into
/// `games.actions_json` (API `ControlAction`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ControlActionMeta {
    pub id: String,
    pub name: String,
    pub keys: Vec<String>,
    pub gamepad: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleMeta {
    pub name: Option<String>,
    pub entry: String,
    pub width: i64,
    pub height: i64,
    pub achievements: Vec<AchievementMeta>,
    pub leaderboard: LeaderboardMeta,
    /// F009: normalised `actions` (strict).
    pub actions: Vec<ControlActionMeta>,
    /// F009: normalised `controls` (lenient), 0-300 chars.
    pub controls_hint: String,
}

impl BundleMeta {
    /// Compact JSON of [`BundleMeta::actions`] for `games.actions_json` (`[]` when none).
    pub fn actions_json(&self) -> String {
        actions_to_json(&self.actions)
    }
}

/// Compact JSON of a normalised action list (`[]` when empty).
pub fn actions_to_json(actions: &[ControlActionMeta]) -> String {
    serde_json::to_string(actions).unwrap_or_else(|_| "[]".into())
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Validation(msg.into())
}

/// OS / tool junk that is silently skipped rather than rejected.
fn is_junk(components: &[&str]) -> bool {
    components.first() == Some(&"__MACOSX")
        || matches!(
            components.last().copied(),
            Some(".DS_Store") | Some("Thumbs.db") | Some("desktop.ini")
        )
}

/// Normalise a zip entry name into safe relative components, or reject it.
fn normalise(raw: &str) -> Result<Vec<String>, AppError> {
    if raw.contains('\0') {
        return Err(invalid("Bundle contains an invalid file name"));
    }
    let name = raw.replace('\\', "/");
    if name.starts_with('/') || name.contains(':') {
        return Err(invalid(format!("Bundle contains an absolute path: {raw}")));
    }
    let mut out = Vec::new();
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                return Err(invalid(format!(
                    "Bundle contains a path traversal entry: {raw}"
                )));
            }
            p => out.push(p.to_string()),
        }
    }
    Ok(out)
}

fn extension(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    let (stem, ext) = file.rsplit_once('.')?;
    if stem.is_empty() && ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Normalise and validate the `entry` field of game.json.
pub fn normalise_entry(entry: &str) -> Result<String, AppError> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Err(invalid("game.json: entry must not be empty"));
    }
    let parts = normalise(entry)
        .map_err(|_| invalid("game.json: entry must be a relative path inside the bundle"))?;
    if parts.is_empty() {
        return Err(invalid(
            "game.json: entry must be a relative path inside the bundle",
        ));
    }
    let joined = parts.join("/");
    if extension(&joined).as_deref() != Some("js") {
        return Err(invalid("game.json: entry must be a .js file"));
    }
    Ok(joined)
}

fn parse_dimension(v: &Value, key: &str) -> Result<i64, AppError> {
    let n = v
        .get(key)
        .and_then(|x| {
            x.as_i64()
                .or_else(|| x.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        })
        .ok_or_else(|| invalid(format!("game.json: {key} must be an integer")))?;
    if !(64..=4096).contains(&n) {
        return Err(invalid(format!(
            "game.json: {key} must be between 64 and 4096"
        )));
    }
    Ok(n)
}

fn valid_achievement_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ACHIEVEMENT_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Validate the optional `achievements` array (icon existence is checked by the caller).
pub fn parse_achievements(v: &Value) -> Result<Vec<AchievementMeta>, AppError> {
    let list = match v.get("achievements") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(invalid("game.json: achievements must be an array")),
    };
    if list.len() > MAX_ACHIEVEMENTS {
        return Err(invalid(format!(
            "game.json: at most {MAX_ACHIEVEMENTS} achievements are allowed"
        )));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let at = format!("game.json: achievements[{i}]");
        let obj = item
            .as_object()
            .ok_or_else(|| invalid(format!("{at} must be an object")))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("{at}.id is required")))?;
        if !valid_achievement_id(id) {
            return Err(invalid(format!(
                "{at}.id must match ^[a-z0-9_-]{{1,{ACHIEVEMENT_ID_MAX}}}$"
            )));
        }
        if !seen.insert(id.to_string()) {
            return Err(invalid(format!(
                "game.json: duplicate achievement id '{id}'"
            )));
        }
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .ok_or_else(|| invalid(format!("{at}.name is required")))?;
        let n = name.chars().count();
        if n == 0 || n > ACHIEVEMENT_NAME_MAX {
            return Err(invalid(format!(
                "{at}.name must be 1-{ACHIEVEMENT_NAME_MAX} characters"
            )));
        }
        let description = match obj.get("description") {
            None | Some(Value::Null) => "",
            Some(Value::String(d)) => d.trim(),
            Some(_) => return Err(invalid(format!("{at}.description must be a string"))),
        };
        if description.chars().count() > ACHIEVEMENT_DESCRIPTION_MAX {
            return Err(invalid(format!(
                "{at}.description must be at most {ACHIEVEMENT_DESCRIPTION_MAX} characters"
            )));
        }
        let icon = match obj.get("icon") {
            None | Some(Value::Null) => None,
            Some(Value::String(p)) if p.trim().is_empty() => None,
            Some(Value::String(p)) => {
                let parts = normalise(p.trim()).map_err(|_| {
                    invalid(format!(
                        "{at}.icon must be a relative path inside the bundle"
                    ))
                })?;
                if parts.is_empty() {
                    return Err(invalid(format!(
                        "{at}.icon must be a relative path inside the bundle"
                    )));
                }
                let joined = parts.join("/");
                match extension(&joined) {
                    Some(ext) if ICON_EXTS.contains(&ext.as_str()) => {}
                    _ => {
                        return Err(invalid(format!(
                            "{at}.icon must be an image ({})",
                            ICON_EXTS.join(", ")
                        )));
                    }
                }
                Some(joined)
            }
            Some(_) => return Err(invalid(format!("{at}.icon must be a string"))),
        };
        out.push(AchievementMeta {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            icon,
        });
    }
    Ok(out)
}

/// Validate the optional `leaderboard` object of game.json (`v` is the whole manifest).
/// Absent (or `null`) block/keys take their defaults; unknown keys are ignored.
pub fn parse_leaderboard(v: &Value) -> Result<LeaderboardMeta, AppError> {
    let obj = match v.get("leaderboard") {
        None | Some(Value::Null) => return Ok(LeaderboardMeta::default()),
        Some(Value::Object(o)) => o,
        Some(_) => return Err(invalid("game.json: leaderboard must be an object")),
    };
    let mut meta = LeaderboardMeta::default();
    match obj.get("order") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s == "desc" || s == "asc" => meta.order = s.clone(),
        Some(_) => {
            return Err(invalid(
                "game.json: leaderboard.order must be \"desc\" or \"asc\"",
            ));
        }
    }
    match obj.get("format") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s == "number" || s == "time" => meta.format = s.clone(),
        Some(_) => {
            return Err(invalid(
                "game.json: leaderboard.format must be \"number\" or \"time\"",
            ));
        }
    }
    match obj.get("label") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            let label = s.trim();
            if label.chars().count() > LEADERBOARD_LABEL_MAX {
                return Err(invalid(format!(
                    "game.json: leaderboard.label must be at most {LEADERBOARD_LABEL_MAX} characters"
                )));
            }
            meta.label = label.to_string();
        }
        Some(_) => return Err(invalid("game.json: leaderboard.label must be a string")),
    }
    Ok(meta)
}

fn valid_action_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ACTION_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A user-supplied value quoted for an error message (JSON-escaped, at most 40 chars).
fn quoted(s: &str) -> String {
    let short: String = s.chars().take(40).collect();
    let short = if short.len() < s.len() {
        format!("{short}…")
    } else {
        short
    };
    serde_json::to_string(&short).unwrap_or_else(|_| "\"\"".into())
}

/// A `keys` / `gamepad` list of one action: optional (absent or `null` → `[]`), at most `max`
/// unique strings from `table`.
fn parse_binding_list(
    obj: &serde_json::Map<String, Value>,
    at: &str,
    field: &str,
    max: usize,
    table: &[&str],
    not_allowed: &str,
) -> Result<Vec<String>, AppError> {
    let list = match obj.get(field) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(invalid(format!("{at}.{field} must be an array"))),
    };
    if list.len() > max {
        return Err(invalid(format!(
            "{at}.{field} must have at most {max} entries"
        )));
    }
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for (j, item) in list.iter().enumerate() {
        let s = item
            .as_str()
            .ok_or_else(|| invalid(format!("{at}.{field}[{j}] must be a string")))?;
        if !table.contains(&s) {
            return Err(invalid(format!(
                "{at}.{field}[{j}] {} {not_allowed}",
                quoted(s)
            )));
        }
        if out.iter().any(|k| k == s) {
            return Err(invalid(format!(
                "{at}.{field}[{j}] {} is a duplicate",
                quoted(s)
            )));
        }
        out.push(s.to_string());
    }
    Ok(out)
}

/// F009: validate the optional `actions` array of game.json (`v` is the whole manifest),
/// strictly (GAME_FORMAT.md § F009). The first violation is a 422 `validation` naming the
/// path. Unknown keys inside an action are dropped.
pub fn parse_actions(v: &Value) -> Result<Vec<ControlActionMeta>, AppError> {
    let list = match v.get("actions") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(invalid("game.json: actions must be an array")),
    };
    if list.len() > MAX_ACTIONS {
        return Err(invalid(format!(
            "game.json: at most {MAX_ACTIONS} actions are allowed"
        )));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let at = format!("game.json: actions[{i}]");
        let obj = item
            .as_object()
            .ok_or_else(|| invalid(format!("{at} must be an object")))?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_action_id(id))
            .ok_or_else(|| {
                invalid(format!(
                    "{at}.id must match ^[a-z0-9_-]{{1,{ACTION_ID_MAX}}}$"
                ))
            })?;
        if !seen.insert(id) {
            return Err(invalid(format!("{at}.id {} is a duplicate", quoted(id))));
        }
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .ok_or_else(|| invalid(format!("{at}.name must be a string")))?;
        let n = name.chars().count();
        if n == 0 || n > ACTION_NAME_MAX {
            return Err(invalid(format!(
                "{at}.name must be 1-{ACTION_NAME_MAX} characters"
            )));
        }
        if name
            .chars()
            .any(|c| c.is_control() || crate::versions::is_bidi_control(c))
        {
            return Err(invalid(format!("{at}.name contains invalid characters")));
        }
        let keys = parse_binding_list(
            obj,
            &at,
            "keys",
            MAX_ACTION_KEYS,
            BINDABLE_KEYS,
            "can't be bound",
        )?;
        let gamepad = parse_binding_list(
            obj,
            &at,
            "gamepad",
            MAX_ACTION_GAMEPAD,
            GAMEPAD_BUTTONS,
            "is not a gamepad button",
        )?;
        if keys.is_empty() && gamepad.is_empty() {
            return Err(invalid(format!(
                "{at} needs at least one key or gamepad button"
            )));
        }
        out.push(ControlActionMeta {
            id: id.to_string(),
            name: name.to_string(),
            keys,
            gamepad,
        });
    }
    Ok(out)
}

/// F009: the free-text `controls` string of game.json (`v` is the whole manifest), leniently
/// normalised; never fails. Control characters become spaces, bidi controls are removed,
/// whitespace runs collapse to one space, then trim and cut to 300 chars. Non-strings → `""`.
pub fn parse_controls_hint(v: &Value) -> String {
    let Some(raw) = v.get("controls").and_then(Value::as_str) else {
        return String::new();
    };
    let mut out = String::with_capacity(raw.len().min(CONTROLS_HINT_MAX * 4));
    let mut count = 0usize;
    let mut pending_space = false;
    for c in raw.chars() {
        if crate::versions::is_bidi_control(c) {
            continue;
        }
        if c.is_control() || c.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && count > 0 {
            if count + 1 >= CONTROLS_HINT_MAX {
                break;
            }
            out.push(' ');
            count += 1;
        }
        pending_space = false;
        if count >= CONTROLS_HINT_MAX {
            break;
        }
        out.push(c);
        count += 1;
    }
    out
}

pub fn parse_game_json(bytes: &[u8]) -> Result<BundleMeta, AppError> {
    let v: Value = serde_json::from_slice(bytes)
        .map_err(|e| invalid(format!("game.json is not valid JSON: {e}")))?;
    if !v.is_object() {
        return Err(invalid("game.json must be a JSON object"));
    }
    let entry = v
        .get("entry")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("game.json: entry is required"))?;
    let entry = normalise_entry(entry)?;
    let width = parse_dimension(&v, "width")?;
    let height = parse_dimension(&v, "height")?;
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let achievements = parse_achievements(&v)?;
    let leaderboard = parse_leaderboard(&v)?;
    let actions = parse_actions(&v)?;
    let controls_hint = parse_controls_hint(&v);
    Ok(BundleMeta {
        name,
        entry,
        width,
        height,
        achievements,
        leaderboard,
        actions,
        controls_hint,
    })
}

struct Entry {
    index: usize,
    /// Path inside the bundle after optional top-level folder stripping.
    path: String,
    size: u64,
}

/// Validate `bytes` as a game bundle and extract it into `dest` (created; must not exist).
/// On error, nothing is left in `dest`.
pub fn validate_and_extract(bytes: &[u8], dest: &Path) -> Result<BundleMeta, AppError> {
    let result = extract_inner(bytes, dest);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dest);
    }
    result
}

/// Validate only (no extraction).
pub fn validate(bytes: &[u8]) -> Result<BundleMeta, AppError> {
    let (meta, _) = scan(bytes)?;
    Ok(meta)
}

fn scan(bytes: &[u8]) -> Result<(BundleMeta, Vec<Entry>), AppError> {
    if bytes.len() > MAX_COMPRESSED {
        return Err(AppError::PayloadTooLarge(
            "Bundle must be at most 50MB".into(),
        ));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| invalid(format!("Bundle is not a valid zip file: {e}")))?;

    let mut raw: Vec<(usize, Vec<String>, u64)> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let file = archive
            .by_index_raw(i)
            .map_err(|e| invalid(format!("Bundle is not a valid zip file: {e}")))?;
        let name = file.name().to_string();
        if file.is_symlink() {
            return Err(invalid(format!("Bundle contains a symlink: {name}")));
        }
        if file.encrypted() {
            return Err(invalid(format!(
                "Bundle contains an encrypted file: {name}"
            )));
        }
        let parts = normalise(&name)?;
        if file.enclosed_name().is_none() {
            return Err(invalid(format!("Bundle contains an unsafe path: {name}")));
        }
        if file.is_dir() || parts.is_empty() {
            continue;
        }
        let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
        if is_junk(&refs) {
            continue;
        }
        let joined = parts.join("/");
        match extension(&joined) {
            Some(ext) if ALLOWED_EXTS.contains(&ext.as_str()) => {}
            _ => {
                return Err(invalid(format!(
                    "File type not allowed in bundle: {joined} (allowed: {})",
                    ALLOWED_EXTS.join(", ")
                )));
            }
        }
        total = total.saturating_add(file.size());
        if total > MAX_UNCOMPRESSED {
            return Err(AppError::PayloadTooLarge(
                "Bundle must be at most 200MB uncompressed".into(),
            ));
        }
        raw.push((i, parts, file.size()));
        if raw.len() > MAX_FILES {
            return Err(invalid(format!(
                "Bundle must contain at most {MAX_FILES} files"
            )));
        }
    }
    if raw.is_empty() {
        return Err(invalid("Bundle is empty"));
    }

    // Single top-level folder stripping.
    let has_root_manifest = raw
        .iter()
        .any(|(_, p, _)| p.len() == 1 && p[0] == "game.json");
    let mut strip = 0;
    if !has_root_manifest {
        let first = &raw[0].1[0];
        let single_folder = raw.iter().all(|(_, p, _)| p.len() > 1 && &p[0] == first);
        let nested_manifest = raw
            .iter()
            .any(|(_, p, _)| p.len() == 2 && &p[0] == first && p[1] == "game.json");
        if single_folder && nested_manifest {
            strip = 1;
        } else {
            return Err(invalid(
                "game.json is missing (it must be at the zip root or inside a single top-level folder)",
            ));
        }
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(raw.len());
    for (index, parts, size) in raw {
        let path = parts[strip..].join("/");
        if !seen.insert(path.to_ascii_lowercase()) {
            return Err(invalid(format!("Bundle contains a duplicate file: {path}")));
        }
        entries.push(Entry { index, path, size });
    }
    // A path that is both a file and a parent directory of another file (`x` and `x/y`)
    // cannot be extracted (R8).
    let mut dirs = HashSet::new();
    for e in &entries {
        let lower = e.path.to_ascii_lowercase();
        for (i, _) in lower.match_indices('/') {
            dirs.insert(lower[..i].to_string());
        }
    }
    if let Some(e) = entries
        .iter()
        .find(|e| dirs.contains(&e.path.to_ascii_lowercase()))
    {
        return Err(invalid(format!(
            "Bundle contains a file that is also a folder: {}",
            e.path
        )));
    }

    let manifest = entries
        .iter()
        .find(|e| e.path == "game.json")
        .ok_or_else(|| invalid("game.json is missing"))?;
    if manifest.size > 1024 * 1024 {
        return Err(invalid("game.json is too large"));
    }
    let mut buf = Vec::new();
    archive
        .by_index(manifest.index)
        .map_err(|e| invalid(format!("Could not read game.json: {e}")))?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| invalid(format!("Could not read game.json: {e}")))?;
    let meta = parse_game_json(&buf)?;
    if !entries.iter().any(|e| e.path == meta.entry) {
        return Err(invalid(format!(
            "game.json: entry file '{}' is not in the bundle",
            meta.entry
        )));
    }
    for a in &meta.achievements {
        if let Some(icon) = &a.icon
            && !entries.iter().any(|e| &e.path == icon)
        {
            return Err(invalid(format!(
                "game.json: icon '{icon}' of achievement '{}' is not in the bundle",
                a.id
            )));
        }
    }
    Ok((meta, entries))
}

fn extract_inner(bytes: &[u8], dest: &Path) -> Result<BundleMeta, AppError> {
    let (meta, entries) = scan(bytes)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| invalid(format!("Bundle is not a valid zip file: {e}")))?;
    std::fs::create_dir_all(dest)?;
    let mut written: u64 = 0;
    for entry in entries {
        let mut file = archive
            .by_index(entry.index)
            .map_err(|e| invalid(format!("Could not read {}: {e}", entry.path)))?;
        let target = entry
            .path
            .split('/')
            .fold(dest.to_path_buf(), |acc, part| acc.join(part));
        if !target.starts_with(dest) {
            return Err(invalid(format!(
                "Bundle contains an unsafe path: {}",
                entry.path
            )));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        // Never trust the declared size: cap what we actually inflate.
        let remaining = MAX_UNCOMPRESSED - written;
        let mut limited = (&mut file).take(remaining + 1);
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = limited
                .read(&mut chunk)
                .map_err(|e| invalid(format!("Could not read {}: {e}", entry.path)))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > MAX_UNCOMPRESSED {
                return Err(AppError::PayloadTooLarge(
                    "Bundle must be at most 200MB uncompressed".into(),
                ));
            }
            out.write_all(&chunk[..n])?;
        }
    }
    Ok(meta)
}
