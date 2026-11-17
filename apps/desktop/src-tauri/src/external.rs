//! Links that ask for a new window (`<a target="_blank">`, `window.open`) open in the system browser.
//!
//! Without a new-window handler the webview silently drops such requests (wry marks WebView2's
//! `NewWindowRequested` as handled), so "Open image" in the screenshot lightbox (F005 game page, F015 feed and
//! profile) and the admin report thumbnails did nothing on the desktop. The main window is therefore created in
//! Rust (`create: false` in tauri.conf.json) with [`handle_new_window`], which:
//! - never opens a second webview (always `Deny`);
//! - hands plain `http(s)` URLs with a host and no credentials, at most `MAX_URL_LEN` bytes, to the OS default
//!   browser; every other scheme (`file:`, `javascript:`, `data:`, custom protocols) is ignored;
//! - opens at most one URL per `MIN_INTERVAL`, so a runaway `window.open` loop can't flood the desktop.
//!
//! Game iframes can't reach this: their sandbox (`allow-scripts allow-pointer-lock`) has no `allow-popups`.

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Runtime, Url};

pub(crate) const MAX_URL_LEN: usize = 2048;
pub(crate) const MIN_INTERVAL: Duration = Duration::from_millis(500);

/// The URL to hand to the system browser, or `None` when it must not leave the app.
pub(crate) fn external_url(url: &Url) -> Option<&str> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let s = url.as_str();
    if s.len() > MAX_URL_LEN
        || s.chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '"')
    {
        return None;
    }
    Some(s)
}

/// Allows one open per [`MIN_INTERVAL`].
#[derive(Default)]
pub(crate) struct Throttle(Mutex<Option<Instant>>);

impl Throttle {
    pub(crate) fn allow(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match *last {
            Some(t) if now.saturating_duration_since(t) < MIN_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

/// The URL to open now, if any (validation first, so rejected URLs don't use up the interval).
pub(crate) fn decide<'a>(url: &'a Url, throttle: &Throttle, now: Instant) -> Option<&'a str> {
    let s = external_url(url)?;
    throttle.allow(now).then_some(s)
}

/// `on_new_window` handler of the main window: maybe opens the system browser, never a new webview.
pub(crate) fn handle_new_window<R: Runtime>(
    url: &Url,
    throttle: &Throttle,
) -> NewWindowResponse<R> {
    if let Some(s) = decide(url, throttle, Instant::now()) {
        if let Err(e) = open_in_browser(s) {
            eprintln!("could not open the system browser: {e}");
        }
    }
    NewWindowResponse::Deny
}

/// Opens `url` (already validated by [`external_url`]) with the OS default handler. The URL is a single
/// argument (no shell), and the child is reaped on a background thread.
fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn opens_screenshot_images_from_the_configured_server() {
        for s in [
            "http://localhost:8080/media/screenshots/s1.png",
            "http://192.168.1.5:8080/media/screenshots/abc.webp",
            "https://arcade.example/media/screenshots/abc.jpg?v=2#x",
        ] {
            assert_eq!(external_url(&u(s)), Some(s));
        }
    }

    #[test]
    fn rejects_other_schemes_credentials_and_huge_urls() {
        for s in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://localhost/index.html",
            "ms-settings:privacy",
            "ftp://example.com/x",
            "http://user:pw@example.com/x.png",
            "http://user@example.com/x.png",
        ] {
            assert_eq!(external_url(&u(s)), None, "{s}");
        }
        let long = format!("https://arcade.example/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(external_url(&u(&long)), None);
    }

    #[test]
    fn quotes_and_spaces_never_reach_the_command_line() {
        // The URL parser percent-encodes them; the guard is a second line of defence.
        let parsed = u("https://arcade.example/a b\"c?q=\"x y\"");
        let s = external_url(&parsed).unwrap();
        assert!(!s.contains(' ') && !s.contains('"'), "{s}");
    }

    #[test]
    fn throttles_bursts_but_not_invalid_urls() {
        let t = Throttle::default();
        let now = Instant::now();
        let ok = u("https://arcade.example/media/screenshots/s1.png");
        let bad = u("file:///etc/passwd");
        assert_eq!(decide(&bad, &t, now), None);
        assert!(
            decide(&ok, &t, now).is_some(),
            "an invalid URL must not use up the interval"
        );
        assert_eq!(decide(&ok, &t, now + MIN_INTERVAL / 2), None);
        assert!(decide(&ok, &t, now + MIN_INTERVAL).is_some());
    }
}
