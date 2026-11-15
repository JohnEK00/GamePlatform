//! Native OS notifications (F007), shown from Rust with `tauri-plugin-notification`.
//!
//! The webview gets no `notification:*` permission. It only calls these app commands:
//! - `os_notifications_status()` / `request_os_notifications()` → `"granted" | "denied" | "prompt"`, or
//!   `"unsupported"` when the crate is built without the `os-notifications` feature;
//! - `show_os_notification(title, body)`: strips control and bidi-override characters, trims, requires a title of
//!   1–64 and a body of 1–240 characters (else `Err`), and is rate limited to 5 per 60 s (over the limit → `Ok(false)`,
//!   nothing shown). `Ok(true)` once the notification was handed to the OS; always `Ok(false)` without the feature.
//!
//! The UI decides when to show something and only ever sends summary text (never comment excerpts).

#[cfg(any(feature = "os-notifications", test))]
use std::sync::Mutex;
#[cfg(any(feature = "os-notifications", test))]
use std::time::{Duration, Instant};

#[cfg(not(feature = "os-notifications"))]
pub const UNSUPPORTED: &str = "unsupported";

#[cfg(any(feature = "os-notifications", test))]
const TITLE_MAX: usize = 64;
#[cfg(any(feature = "os-notifications", test))]
const BODY_MAX: usize = 240;
/// Bucket size and refill period: at most `RATE_BURST` notifications per `RATE_WINDOW`.
#[cfg(any(feature = "os-notifications", test))]
const RATE_BURST: f64 = 5.0;
#[cfg(any(feature = "os-notifications", test))]
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Bidirectional formatting characters (ALM, LRM, RLM, embeddings/overrides, isolates). They can make a
/// notification read differently from what was sent, so they are removed like control characters.
#[cfg(any(feature = "os-notifications", test))]
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Removes control and bidi characters (whitespace controls such as `\n`/`\t` become a space), trims, and
/// checks the length in characters (`1..=max`).
#[cfg(any(feature = "os-notifications", test))]
fn clean(input: &str, max: usize, what: &str) -> Result<String, String> {
    let cleaned: String = input
        .chars()
        .filter_map(|c| {
            if c.is_control() {
                c.is_whitespace().then_some(' ')
            } else if is_bidi_control(c) {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    let len = cleaned.chars().count();
    if len == 0 {
        return Err(format!("notification {what} is empty"));
    }
    if len > max {
        return Err(format!("notification {what} is too long (max {max} characters)"));
    }
    Ok(cleaned.to_string())
}

/// Validated `(title, body)`.
#[cfg(any(feature = "os-notifications", test))]
fn sanitize(title: &str, body: &str) -> Result<(String, String), String> {
    Ok((clean(title, TITLE_MAX, "title")?, clean(body, BODY_MAX, "body")?))
}

/// Token bucket: `RATE_BURST` tokens, refilled continuously over `RATE_WINDOW`.
#[cfg(any(feature = "os-notifications", test))]
#[derive(Default)]
pub struct ShowBucket(Mutex<Option<(f64, Instant)>>);

#[cfg(any(feature = "os-notifications", test))]
impl ShowBucket {
    /// Takes one token at `now`; false when the bucket is empty.
    fn try_take(&self, now: Instant) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let tokens = match *state {
            None => RATE_BURST,
            Some((tokens, last)) => {
                let elapsed = now.saturating_duration_since(last).as_secs_f64();
                (tokens + elapsed * RATE_BURST / RATE_WINDOW.as_secs_f64()).min(RATE_BURST)
            }
        };
        if tokens >= 1.0 {
            *state = Some((tokens - 1.0, now));
            true
        } else {
            *state = Some((tokens, now));
            false
        }
    }
}

#[cfg(feature = "os-notifications")]
fn state_name(state: tauri_plugin_notification::PermissionState) -> &'static str {
    use tauri_plugin_notification::PermissionState;
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
}

#[cfg(feature = "os-notifications")]
#[tauri::command]
pub fn os_notifications_status(app: tauri::AppHandle) -> String {
    use tauri_plugin_notification::NotificationExt;
    app.notification().permission_state().map(state_name).unwrap_or("prompt").into()
}

#[cfg(not(feature = "os-notifications"))]
#[tauri::command]
pub fn os_notifications_status() -> String {
    UNSUPPORTED.into()
}

/// Asks the OS for permission where it requires one (desktop plugins report "granted" without a prompt).
#[cfg(feature = "os-notifications")]
#[tauri::command]
pub async fn request_os_notifications(app: tauri::AppHandle) -> String {
    use tauri_plugin_notification::NotificationExt;
    app.notification().request_permission().map(state_name).unwrap_or("denied").into()
}

#[cfg(not(feature = "os-notifications"))]
#[tauri::command]
pub async fn request_os_notifications() -> String {
    UNSUPPORTED.into()
}

#[cfg(feature = "os-notifications")]
#[tauri::command]
pub fn show_os_notification(
    app: tauri::AppHandle,
    bucket: tauri::State<'_, ShowBucket>,
    title: String,
    body: String,
) -> Result<bool, String> {
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = sanitize(&title, &body)?;
    if !bucket.try_take(Instant::now()) {
        return Ok(false);
    }
    // The plugin shows it under the app's identifier (tauri.conf.json) on a background task.
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("cannot show notification: {e}"))?;
    Ok(true)
}

#[cfg(not(feature = "os-notifications"))]
#[tauri::command]
pub fn show_os_notification(title: String, body: String) -> Result<bool, String> {
    let _ = (title, body);
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_control_and_bidi_characters() {
        let (t, b) = sanitize("  Mia\u{202E}gnp.exe\u{0007} ", "replied\nto\tyou\u{200F} on \u{2066}Space\u{2069} Dodge\u{7F}").unwrap();
        assert_eq!(t, "Miagnp.exe");
        assert_eq!(b, "replied to you on Space Dodge");
    }

    #[test]
    fn enforces_lengths_in_characters() {
        assert!(sanitize("", "body").is_err());
        assert!(sanitize("title", " \u{202A}\n ").is_err(), "only stripped characters → empty");
        assert!(sanitize(&"x".repeat(TITLE_MAX), &"é".repeat(BODY_MAX)).is_ok(), "limits are inclusive, in chars");
        assert!(sanitize(&"x".repeat(TITLE_MAX + 1), "body").is_err());
        assert!(sanitize("title", &"é".repeat(BODY_MAX + 1)).is_err());
    }

    #[test]
    fn bucket_allows_five_per_minute() {
        let bucket = ShowBucket::default();
        let start = Instant::now();
        for i in 0..5 {
            assert!(bucket.try_take(start + Duration::from_millis(i)), "burst of 5 is allowed");
        }
        assert!(!bucket.try_take(start + Duration::from_secs(1)), "6th within the window is dropped");
        assert!(!bucket.try_take(start + Duration::from_secs(5)));
        // One token refills every 12 s.
        assert!(bucket.try_take(start + Duration::from_secs(13)));
        assert!(!bucket.try_take(start + Duration::from_secs(14)));
        // After a full window the bucket is full again, but never above 5.
        let later = start + Duration::from_secs(600);
        for i in 0..5 {
            assert!(bucket.try_take(later + Duration::from_millis(i)));
        }
        assert!(!bucket.try_take(later + Duration::from_millis(10)));
    }

    #[cfg(not(feature = "os-notifications"))]
    #[test]
    fn unsupported_without_the_feature() {
        assert_eq!(os_notifications_status(), UNSUPPORTED);
        assert_eq!(tauri::async_runtime::block_on(request_os_notifications()), UNSUPPORTED);
        assert_eq!(show_os_notification("Pixelforge Arcade".into(), "Hello".into()), Ok(false));
    }
}
