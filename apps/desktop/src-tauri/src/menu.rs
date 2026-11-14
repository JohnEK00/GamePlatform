//! Native application menu. Window actions (reload, fullscreen, devtools, about, quit) run in Rust;
//! navigation items are forwarded to the webview as a `MENU_EVENT` event whose payload is the item id
//! (`"upload"`, `"open-folder"`, `"settings"`, `"feed"`, `"docs"`), handled in src/nativeMenu.ts.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub const MENU_EVENT: &str = "app-menu";
const MAIN_WINDOW: &str = "main";
/// Ids forwarded to the webview.
const FORWARDED: &[&str] = &["upload", "open-folder", "settings", "feed", "docs"];

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
        .item(&MenuItemBuilder::with_id("upload", "&Upload game").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "&Open local game folder…").accelerator("CmdOrCtrl+O").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "&Settings").build(app)?)
        .separator()
        .item(&quit.build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "&View")
        .item(&MenuItemBuilder::with_id("feed", "F&eed").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("reload", "&Reload").accelerator("CmdOrCtrl+R").build(app)?)
        .item(&MenuItemBuilder::with_id("fullscreen", "Toggle &Fullscreen").accelerator("F11").build(app)?);
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
        assert!(!t.should_toggle(start + Duration::from_millis(100)), "double fire is ignored");
        assert!(t.should_toggle(start + Duration::from_millis(500)));
    }

    #[test]
    fn feed_is_forwarded_to_the_webview() {
        assert!(FORWARDED.contains(&"feed"));
    }
}
