//! Links that ask for a new window (`<a target="_blank">`, `window.open`) open in the system browser.
//!
//! Without a new-window handler the webview silently drops such requests (wry marks WebView2's
//! `NewWindowRequested` as handled), so "Open image" in the screenshot lightbox (F005 game page, F015 feed and
//! profile) and the admin report thumbnails did nothing on the desktop. The main window is therefore created in
//! Rust (`create: false` in tauri.conf.json) with [`handle_new_window`], which:
//! - never opens a second webview (always `Deny`);
//! - hands plain `http(s)` URLs with a host and no credentials, at most `MAX_URL_LEN` bytes, to the OS default
//!   browser; every other scheme (`file:`, `javascript:`, `data:`, custom protocols) is ignored;
//! - ignores the app's own pages: WebView2 also raises `NewWindowRequested` for Ctrl-, Shift- and middle-clicks on
//!   in-app links (`#/games/…` resolves to `http://tauri.localhost/#/games/…`), and in a browser that address is
//!   dead. Such requests are simply denied, as they were before external links were handled (the user can
//!   click the link normally). The same goes for the `devUrl` dev server (`http://localhost:1420`);
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

/// Origins the main webview itself is served from: Windows/Android (`http(s)://tauri.localhost`, depending on
/// `useHttpsScheme`) and macOS/Linux/iOS (`tauri://localhost`).
const WEBVIEW_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

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

/// Scheme, host and port (with the scheme's default filled in). Compared field by field because
/// `Url::origin()` is opaque, and therefore never equal, for non-special schemes such as `tauri:`.
fn origin_key(url: &Url) -> (String, Option<String>, Option<u16>) {
    let host = url
        .host_str()
        .map(|h| h.trim_end_matches('.').to_ascii_lowercase());
    (url.scheme().to_owned(), host, url.port_or_known_default())
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

/// What the main window's new-window handler lets out: the app's own origins stay in, and opens are throttled.
pub(crate) struct Policy {
    app_origins: Vec<(String, Option<String>, Option<u16>)>,
    throttle: Throttle,
}

impl Policy {
    /// `dev_url` is `build.devUrl` from tauri.conf.json (the Vite dev server), whose pages are the app too.
    pub(crate) fn new(dev_url: Option<&Url>) -> Self {
        let app_origins = WEBVIEW_ORIGINS
            .iter()
            .filter_map(|s| s.parse::<Url>().ok())
            .chain(dev_url.cloned())
            .map(|u| origin_key(&u))
            .collect();
        Self {
            app_origins,
            throttle: Throttle::default(),
        }
    }

    /// True when `url` is one of the app's own pages (opening it in a browser shows a dead page).
    pub(crate) fn is_app_url(&self, url: &Url) -> bool {
        self.app_origins.contains(&origin_key(url))
    }
}

/// The URL to open now, if any (validation first, so rejected URLs don't use up the interval).
pub(crate) fn decide<'a>(url: &'a Url, policy: &Policy, now: Instant) -> Option<&'a str> {
    let s = external_url(url)?;
    if policy.is_app_url(url) {
        return None;
    }
    policy.throttle.allow(now).then_some(s)
}

/// `on_new_window` handler of the main window: maybe calls `open` (the system browser in the app), never opens
/// a new webview.
pub(crate) fn handle_new_window<R: Runtime>(
    url: &Url,
    policy: &Policy,
    open: impl FnOnce(&str) -> std::io::Result<()>,
) -> NewWindowResponse<R> {
    open_external(url, policy, Instant::now(), open);
    NewWindowResponse::Deny
}

/// Everything [`handle_new_window`] does besides denying, without a runtime type, so tests can drive it with a
/// recording opener (a unit test that names `tauri::Wry` links window code into the test executable, which then
/// can't start on Windows without the app's Common Controls v6 manifest). Returns the URL handed to `open`.
pub(crate) fn open_external<'a>(
    url: &'a Url,
    policy: &Policy,
    now: Instant,
    open: impl FnOnce(&str) -> std::io::Result<()>,
) -> Option<&'a str> {
    let s = decide(url, policy, now)?;
    if let Err(e) = open(s) {
        eprintln!("could not open the system browser: {e}");
    }
    Some(s)
}

/// The program and arguments that open `url` with the default handler on `os` (`std::env::consts::OS`).
/// A pure function so every platform's choice is compiled and tested on every platform.
pub(crate) fn browser_command<'a>(os: &str, url: &'a str) -> (&'static str, Vec<&'a str>) {
    match os {
        "windows" => ("rundll32.exe", vec!["url.dll,FileProtocolHandler", url]),
        "macos" => ("open", vec![url]),
        _ => ("xdg-open", vec![url]),
    }
}

/// Opens `url` (already validated by [`external_url`]) with the OS default handler. The URL is a single
/// argument (no shell), and the child is reaped on a background thread.
pub(crate) fn open_in_browser(url: &str) -> std::io::Result<()> {
    let (program, args) = browser_command(std::env::consts::OS, url);
    let mut child = Command::new(program)
        .args(args)
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
    use std::cell::RefCell;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    fn dev() -> Url {
        u("http://localhost:1420")
    }

    fn policy() -> Policy {
        Policy::new(Some(&dev()))
    }

    /// Runs the handler's logic with a recording opener; returns what was handed to the opener.
    fn run(url: &str, policy: &Policy, now: Instant) -> Vec<String> {
        let opened = RefCell::new(Vec::new());
        let parsed = u(url);
        let ret = open_external(&parsed, policy, now, |s| {
            opened.borrow_mut().push(s.to_owned());
            Ok(())
        });
        let opened = opened.into_inner();
        assert_eq!(ret.map(str::to_owned), opened.first().cloned());
        opened
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
    fn in_app_links_never_leave_the_app() {
        let p = policy();
        let now = Instant::now();
        for s in [
            "http://tauri.localhost/#/games/g1",
            "http://tauri.localhost/",
            "http://TAURI.localhost:80/#/feed",
            "http://tauri.localhost./#/feed",
            "https://tauri.localhost/#/u/mia",
            "https://tauri.localhost:443/index.html",
            "tauri://localhost/#/games/g1",
            "http://localhost:1420/#/games/g1",
            "http://LOCALHOST:1420/",
        ] {
            assert!(p.is_app_url(&u(s)), "{s}");
            assert_eq!(decide(&u(s), &p, now), None, "{s}");
        }
    }

    #[test]
    fn similar_but_different_origins_still_open() {
        let p = policy();
        for s in [
            // The default API server and other ports on localhost are not the dev server.
            "http://localhost:8080/media/screenshots/s1.png",
            "http://localhost:1421/x.png",
            "https://localhost:1420/x.png",
            "http://127.0.0.1:1420/x.png",
            "http://tauri.localhost:8080/x.png",
            "http://asset.tauri.localhost/x.png",
            "http://tauri.localhost.example/x.png",
        ] {
            assert!(!p.is_app_url(&u(s)), "{s}");
        }
        // Without a devUrl only the webview origins are the app.
        let no_dev = Policy::new(None);
        assert!(!no_dev.is_app_url(&u("http://localhost:1420/#/games/g1")));
        assert!(no_dev.is_app_url(&u("http://tauri.localhost/#/games/g1")));
    }

    #[test]
    fn throttles_bursts_but_not_rejected_urls() {
        let p = policy();
        let now = Instant::now();
        let ok = u("https://arcade.example/media/screenshots/s1.png");
        assert_eq!(decide(&u("file:///etc/passwd"), &p, now), None);
        assert_eq!(decide(&u("http://tauri.localhost/#/feed"), &p, now), None);
        assert!(
            decide(&ok, &p, now).is_some(),
            "a rejected URL must not use up the interval"
        );
        assert_eq!(decide(&ok, &p, now + MIN_INTERVAL / 2), None);
        assert!(decide(&ok, &p, now + MIN_INTERVAL).is_some());
    }

    #[test]
    fn handler_opens_only_external_urls() {
        let p = policy();
        let now = Instant::now();
        let img = "http://192.168.1.5:8080/media/screenshots/s1.png";
        assert_eq!(run(img, &p, now), vec![img.to_owned()]);
        // Throttled: nothing opened.
        assert!(run(img, &p, now).is_empty());

        let p = policy();
        for s in [
            "http://tauri.localhost/#/games/g1",
            "https://tauri.localhost/#/games/g1",
            "tauri://localhost/#/games/g1",
            "http://localhost:1420/#/games/g1",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
        ] {
            assert!(run(s, &p, now).is_empty(), "{s}");
        }
        assert_eq!(run(img, &p, now), vec![img.to_owned()]);
    }

    #[test]
    fn handler_survives_a_failing_opener() {
        let p = policy();
        let url = u("https://arcade.example/x.png");
        let ret = open_external(&url, &p, Instant::now(), |_| {
            Err(std::io::Error::other("no browser"))
        });
        assert_eq!(ret, Some("https://arcade.example/x.png"));
    }

    #[test]
    fn handle_new_window_never_creates_a_webview() {
        // Can't be called here (see `open_external`), so pin its body: it delegates and always denies.
        let src = include_str!("external.rs");
        let start = src.find("pub(crate) fn handle_new_window").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert!(body.contains("open_external(url, policy, Instant::now(), open);"));
        assert!(body.trim_end().ends_with("NewWindowResponse::Deny"));
        assert!(!body.contains("Allow") && !body.contains("Create"));
    }

    #[test]
    fn browser_command_per_os_passes_the_url_as_one_argument() {
        let url = "https://arcade.example/x.png?a=1&b=2";
        assert_eq!(
            browser_command("windows", url),
            ("rundll32.exe", vec!["url.dll,FileProtocolHandler", url])
        );
        assert_eq!(browser_command("macos", url), ("open", vec![url]));
        assert_eq!(browser_command("linux", url), ("xdg-open", vec![url]));
        assert_eq!(browser_command("freebsd", url), ("xdg-open", vec![url]));
    }
}
