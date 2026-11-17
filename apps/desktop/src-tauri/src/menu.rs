//! Native application menu. Window actions (reload, fullscreen, devtools, about, quit) run in Rust;
//! navigation items are forwarded to the webview as a `MENU_EVENT` event whose payload is the item id
//! (`"upload"`, `"open-folder"`, `"settings"`, `"feed"`, `"notifications"`, `"collections"`, `"docs"`, `"screenshot"`,
//! `"controls"`), handled in src/nativeMenu.ts. `"notifications"` is View → Notifications (`CmdOrCtrl+Shift+N`, F007);
//! `"collections"` is View → Collections (`CmdOrCtrl+Shift+L`, F008), which opens the user's collections.
//! `"screenshot"` (View → Take Screenshot, `CmdOrCtrl+Shift+S`) is a native accelerator, so it fires even while
//! the sandboxed game iframe has focus; the webview turns it into `PLAYER_SCREENSHOT_EVENT`. Likewise
//! `"controls"` (View → Controls, `CmdOrCtrl+Shift+K`) becomes `PLAYER_CONTROLS_EVENT` (opens the controls panel).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub const MENU_EVENT: &str = "app-menu";
const MAIN_WINDOW: &str = "main";
/// Ids forwarded to the webview.
const FORWARDED: &[&str] = &[
    "upload",
    "open-folder",
    "settings",
    "feed",
    "notifications",
    "collections",
    "docs",
    "screenshot",
    "controls",
];

/// Menu accelerators by item id (`quit` adds `CmdOrCtrl+Q` on macOS only). Native accelerators fire before the
/// game iframe sees the key, so each must be impossible to type into an F019 `ui.textField`: it needs Ctrl/Cmd
/// *without* Alt (AltGr is Ctrl+Alt on Windows and types characters), or is a function key, and it is never a
/// paste shortcut. Enforced by `accelerators_never_collide_with_text_entry`.
const ACCELERATORS: &[(&str, &str)] = &[
    ("open-folder", "CmdOrCtrl+O"),
    ("feed", "CmdOrCtrl+Shift+F"),
    ("notifications", "CmdOrCtrl+Shift+N"),
    ("collections", "CmdOrCtrl+Shift+L"),
    ("screenshot", "CmdOrCtrl+Shift+S"),
    ("controls", "CmdOrCtrl+Shift+K"),
    ("reload", "CmdOrCtrl+R"),
    ("fullscreen", "F11"),
];

fn accelerator(id: &str) -> Option<&'static str> {
    ACCELERATORS
        .iter()
        .find(|(item, _)| *item == id)
        .map(|(_, accel)| *accel)
}

/// A menu item with its accelerator from `ACCELERATORS`, if any.
fn item<R: Runtime>(app: &AppHandle<R>, id: &str, label: &str) -> tauri::Result<MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(id, label);
    match accelerator(id) {
        Some(accel) => builder.accelerator(accel),
        None => builder,
    }
    .build(app)
}

/// The F11 menu accelerator and the webview's F11 key listener can both fire for one key press;
/// toggles closer together than this are treated as one.
const TOGGLE_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct FullscreenToggle(Mutex<Option<Instant>>);

impl FullscreenToggle {
    /// True when a toggle should happen now (and records it).
    fn should_toggle(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| now.saturating_duration_since(t) < TOGGLE_DEBOUNCE) {
            return false;
        }
        *last = Some(now);
        true
    }
}

fn toggle_fullscreen_window<R: Runtime>(window: &WebviewWindow<R>, toggle: &FullscreenToggle) {
    if toggle.should_toggle(Instant::now()) {
        let on = window.is_fullscreen().unwrap_or(false);
        let _ = window.set_fullscreen(!on);
    }
}

/// F11 from the webview's key listener.
#[tauri::command]
pub fn toggle_fullscreen(window: WebviewWindow, toggle: State<'_, FullscreenToggle>) {
    toggle_fullscreen_window(&window, &toggle);
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItemBuilder::with_id("quit", "&Quit");
    #[cfg(target_os = "macos")]
    let quit = quit.accelerator("CmdOrCtrl+Q");
    let file = SubmenuBuilder::new(app, "&File")
        .item(&item(app, "upload", "&Upload game")?)
        .item(&item(app, "open-folder", "&Open local game folder…")?)
        .separator()
        .item(&item(app, "settings", "&Settings")?)
        .separator()
        .item(&quit.build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "&View")
        .item(&item(app, "feed", "F&eed")?)
        .item(&item(app, "notifications", "&Notifications")?)
        .item(&item(app, "collections", "Co&llections")?)
        .item(&item(app, "screenshot", "Take &Screenshot")?)
        .item(&item(app, "controls", "&Controls")?)
        .separator()
        .item(&item(app, "reload", "&Reload")?)
        .item(&item(app, "fullscreen", "Toggle &Fullscreen")?);
    #[cfg(debug_assertions)]
    let view = view
        .separator()
        .item(&MenuItemBuilder::with_id("devtools", "Toggle &Developer Tools").build(app)?);
    let view = view.build()?;

    let help = SubmenuBuilder::new(app, "&Help")
        .item(&MenuItemBuilder::with_id("docs", "&Make a game").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("about", "&About Pixelforge Arcade").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app);
    // macOS needs an Edit menu for clipboard shortcuts in the webview (Windows/Linux handle them natively).
    #[cfg(target_os = "macos")]
    let menu = menu.item(
        &SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?,
    );
    menu.items(&[&file, &view, &help]).build()
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().0.as_str();
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match id {
        "quit" => app.exit(0),
        "reload" => {
            let _ = window.reload();
        }
        "fullscreen" => toggle_fullscreen_window(&window, &app.state::<FullscreenToggle>()),
        #[cfg(debug_assertions)]
        "devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        "about" => {
            let info = app.package_info();
            // Non-blocking: menu events arrive on the main thread.
            app.dialog()
                .message(format!(
                    "{} {}\n\nPlay, make and share tiny WebGL games.\nTauri {}",
                    info.name,
                    info.version,
                    tauri::VERSION
                ))
                .title(format!("About {}", info.name))
                .parent(&window)
                .show(|_| {});
        }
        id if FORWARDED.contains(&id) => {
            let _ = window.set_focus();
            let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, id);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fullscreen_toggles_are_debounced() {
        let t = FullscreenToggle::default();
        let start = Instant::now();
        assert!(t.should_toggle(start));
        assert!(
            !t.should_toggle(start + Duration::from_millis(100)),
            "double fire is ignored"
        );
        assert!(t.should_toggle(start + Duration::from_millis(500)));
    }

    #[test]
    fn feed_is_forwarded_to_the_webview() {
        assert!(FORWARDED.contains(&"feed"));
        assert!(FORWARDED.contains(&"screenshot"));
        assert!(FORWARDED.contains(&"controls"));
        assert!(FORWARDED.contains(&"notifications"));
        assert!(FORWARDED.contains(&"collections"));
    }

    #[test]
    fn accelerators_belong_to_menu_items() {
        for (id, _) in ACCELERATORS {
            assert!(
                FORWARDED.contains(id) || ["reload", "fullscreen"].contains(id),
                "unknown menu item {id}"
            );
        }
        assert_eq!(accelerator("controls"), Some("CmdOrCtrl+Shift+K"));
        assert_eq!(accelerator("fullscreen"), Some("F11"));
        assert_eq!(accelerator("upload"), None);
    }

    /// F019: native accelerators win over the game iframe, so none may be a key a text field types or pastes.
    #[test]
    fn accelerators_never_collide_with_text_entry() {
        for (id, accel) in ACCELERATORS {
            let parts: Vec<String> = accel.split('+').map(str::to_ascii_lowercase).collect();
            let (key, mods) = parts.split_last().expect("non-empty accelerator");
            let has = |names: &[&str]| mods.iter().any(|m| names.contains(&m.as_str()));
            let function_key = key
                .strip_prefix('f')
                .and_then(|n| n.parse::<u8>().ok())
                .is_some_and(|n| (1..=24).contains(&n));
            assert!(
                !has(&["alt", "option", "altgr"]),
                "{id}: {accel} uses Alt; Ctrl+Alt is AltGr on Windows and types characters"
            );
            assert!(
                function_key
                    || has(&[
                        "cmdorctrl",
                        "commandorcontrol",
                        "ctrl",
                        "control",
                        "cmd",
                        "command",
                        "super"
                    ]),
                "{id}: {accel} has no Ctrl/Cmd and is not a function key, so it is typeable"
            );
            assert!(
                !(key == "v" || key == "insert"),
                "{id}: {accel} would swallow paste"
            );
        }
    }
}
