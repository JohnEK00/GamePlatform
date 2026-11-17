#![allow(dead_code)]

use std::io::Write;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;
use webgame_server::ratelimit::ManualClock;
use webgame_server::{AppState, Config, app};

/// Parent of every test directory: `%TEMP%/webgame-tests` (`$TMPDIR/webgame-tests`).
fn tests_parent() -> std::path::PathBuf {
    std::env::temp_dir().join("webgame-tests")
}

/// This process's run directory, created on first use.
///
/// On Windows a `TempDir` can't remove its directory while SQLite still has the database open,
/// and sqlx closes pool connections on background threads after the pool is dropped, so a
/// test's directory outlives the test. Each test process therefore keeps its directories in
/// `webgame-tests/run-<pid>-<nanos>/` and holds `.lock` in it open without
/// `FILE_SHARE_DELETE`. The first call sweeps sibling run directories whose `.lock` can be
/// deleted (their process has exited); a live run's lock can't be deleted, so it is skipped.
/// Leftovers are bounded by the test binaries that ran last, not by the number of runs.
///
/// Elsewhere, files can be unlinked while open, so `TempDir` cleans up and the directories
/// live directly in the parent.
#[cfg(windows)]
fn run_dir() -> &'static std::path::Path {
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::OnceLock;
    static RUN: OnceLock<(std::path::PathBuf, std::fs::File)> = OnceLock::new();
    &RUN.get_or_init(|| {
        let parent = tests_parent();
        std::fs::create_dir_all(&parent).unwrap();
        if let Ok(entries) = std::fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_name().to_string_lossy().starts_with("run-") {
                    continue;
                }
                let lock = path.join(".lock");
                if !lock.exists() || std::fs::remove_file(&lock).is_ok() {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = parent.join(format!("run-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        const FILE_SHARE_READ: u32 = 0x1;
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ)
            .open(dir.join(".lock"))
            .unwrap();
        (dir, lock)
    })
    .0
}

#[cfg(not(windows))]
fn run_dir() -> &'static std::path::Path {
    use std::sync::OnceLock;
    static RUN: OnceLock<std::path::PathBuf> = OnceLock::new();
    RUN.get_or_init(|| {
        let parent = tests_parent();
        std::fs::create_dir_all(&parent).unwrap();
        parent
    })
}

/// A fresh directory for one test (use this, never `tempfile::tempdir()`; see [`run_dir`]).
pub fn test_dir() -> TempDir {
    tempfile::Builder::new()
        .prefix("t")
        .tempdir_in(run_dir())
        .unwrap()
}

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub dir: TempDir,
    /// The rate limiter's clock (M2): frozen unless a test advances it, so bucket refills
    /// never depend on how fast the test runs.
    pub clock: ManualClock,
}

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| {
            panic!(
                "not json ({}): {}",
                self.status,
                String::from_utf8_lossy(&self.body)
            )
        })
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn header(&self, name: &str) -> String {
        self.headers
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    }
    pub fn error_code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
}

pub async fn setup() -> TestApp {
    setup_with(|_| {}).await
}

/// Like `setup`, but lets the test adjust the config before the app is built.
pub async fn setup_with(customize: impl FnOnce(&mut Config)) -> TestApp {
    let dir = test_dir();
    let mut config = Config::for_data_dir(dir.path().join("data"));
    let engine = dir.path().join("engine");
    std::fs::create_dir_all(&engine).unwrap();
    std::fs::write(engine.join("engine.js"), "export function boot() {}").unwrap();
    config.engine_dist = engine;
    customize(&mut config);
    let clock = ManualClock::new();
    let state = AppState::new(config)
        .await
        .unwrap()
        .with_clock(clock.clock());
    TestApp {
        router: app(state.clone()),
        state,
        dir,
        clock,
    }
}

impl TestApp {
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
        extra: &[(&str, &str)],
    ) -> Resp {
        let mut req = Request::builder().method(method).uri(uri);
        if !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
            req = req.header("host", "localhost:8080");
        }
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let res = self
            .router
            .clone()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        // Review-4 L2: background `gamePublished` fan-outs finish before the test goes on.
        self.state.fan_out.idle().await;
        Resp {
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, uri: &str, token: Option<&str>) -> Resp {
        self.send(Method::GET, uri, token, None, vec![], &[]).await
    }

    pub async fn json(&self, method: Method, uri: &str, token: Option<&str>, body: Value) -> Resp {
        self.send(
            method,
            uri,
            token,
            Some("application/json"),
            serde_json::to_vec(&body).unwrap(),
            &[],
        )
        .await
    }

    pub async fn multipart(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        parts: &[Part<'_>],
    ) -> Resp {
        let (ct, body) = multipart_body(parts);
        self.send(method, uri, token, Some(&ct), body, &[]).await
    }

    /// Register a user, returning (token, user id).
    pub async fn register(&self, username: &str) -> (String, String) {
        let r = self
            .json(
                Method::POST,
                "/api/auth/register",
                None,
                json!({ "username": username, "email": format!("{username}@example.com"), "password": "password123" }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        let v = r.json();
        (
            v["token"].as_str().unwrap().to_string(),
            v["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    /// Upload a valid game; returns the Game JSON.
    pub async fn create_game(
        &self,
        token: &str,
        title: &str,
        tags: &str,
        published: bool,
    ) -> Value {
        let zip = valid_bundle();
        let pub_s = if published { "true" } else { "false" };
        let r = self
            .multipart(
                Method::POST,
                "/api/games",
                Some(token),
                &[
                    Part::Text("title", title),
                    Part::Text("description", &format!("{title} description")),
                    Part::Text("tags", tags),
                    Part::Text("published", pub_s),
                    Part::File("bundle", "game.zip", "application/zip", &zip),
                ],
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        r.json()
    }
}

pub enum Part<'a> {
    Text(&'a str, &'a str),
    File(&'a str, &'a str, &'a str, &'a [u8]),
}

pub fn multipart_body(parts: &[Part<'_>]) -> (String, Vec<u8>) {
    let boundary = "----webgame-test-boundary-7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    for p in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match p {
            Part::Text(name, value) => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                        .as_bytes(),
                );
            }
            Part::File(name, filename, ct, data) => {
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {ct}\r\n\r\n"
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(data);
                body.extend_from_slice(b"\r\n");
            }
        }
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

pub fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, data) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

pub const GAME_JSON: &str =
    r#"{ "name": "Space Dodge", "entry": "main.js", "width": 800, "height": 600, "engine": "1" }"#;

pub fn valid_bundle() -> Vec<u8> {
    make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", b"export default { update() {}, render() {} };"),
        ("assets/player.png", b"\x89PNG\r\n\x1a\nfake"),
    ])
}

/// Minimal 1x1-ish PNG header (enough for magic-byte sniffing).
pub fn png_bytes() -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend_from_slice(&[0u8; 32]);
    v
}

/// Runs a test body that needs all of its real-time writes and reads to fall on one UTC day
/// (per-day coalescing in the feed, the `day` leaderboard period). The server reads the wall
/// clock itself, so these tests can't pin the date. If the body fails *and* the UTC date
/// changed while it ran, the failure is put down to midnight and the body is run once more
/// from scratch; it builds its own app, so nothing carries over. Any other failure, or a
/// second failure, is re-raised unchanged, so the assertions are as strict as before.
/// (A week or month boundary is also a day boundary, so this covers those periods too.)
pub async fn same_utc_day<F, Fut>(body: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    for attempt in 1..=2 {
        let start = chrono::Utc::now().date_naive();
        let result = tokio::spawn(body()).await;
        let crossed = chrono::Utc::now().date_naive() != start;
        match result {
            Ok(()) => return,
            Err(e) if attempt == 1 && crossed && e.is_panic() => {
                eprintln!("the UTC day changed while the test ran; running it again");
            }
            Err(e) => match e.try_into_panic() {
                Ok(payload) => std::panic::resume_unwind(payload),
                Err(e) => panic!("test task failed: {e}"),
            },
        }
    }
}
