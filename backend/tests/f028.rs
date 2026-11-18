//! F028: public profiles 2 (banner, links, profile stats, user reports, clearProfile).

mod common;

use std::io::Cursor;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

const MARKER: &[u8] = b"WEBGAME-SECRET-MARKER";
const URL_MSG: &str = "links[0].url must be a full http:// or https:// address";

// ---------------------------------------------------------------------------
// Image fixtures (as in tests/f005.rs)
// ---------------------------------------------------------------------------

fn rgb(w: u32, h: u32) -> DynamicImage {
    DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }))
}

fn encode(img: &DynamicImage, fmt: ImageFormat) -> Vec<u8> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), fmt).unwrap();
    out
}

fn png(w: u32, h: u32) -> Vec<u8> {
    encode(&rgb(w, h), ImageFormat::Png)
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    encode(&rgb(w, h), ImageFormat::Jpeg)
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// A PNG with a `tEXt` chunk (carrying MARKER) right after IHDR.
fn png_with_text(w: u32, h: u32) -> Vec<u8> {
    let src = png(w, h);
    let mut data = b"Comment\0".to_vec();
    data.extend_from_slice(MARKER);
    let mut typed = b"tEXt".to_vec();
    typed.extend_from_slice(&data);
    let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
    chunk.extend_from_slice(&typed);
    chunk.extend_from_slice(&crc32(&typed).to_be_bytes());
    let at = 8 + 25; // signature + IHDR chunk
    let mut out = src[..at].to_vec();
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&src[at..]);
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn assert_err(r: &Resp, status: StatusCode, code: &str, message: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    let v = r.json();
    assert_eq!(v["error"]["code"], code, "{}", r.text());
    assert_eq!(v["error"]["message"], message, "{}", r.text());
}

fn assert_422(r: &Resp, message: &str) {
    assert_err(r, StatusCode::UNPROCESSABLE_ENTITY, "validation", message);
}

async fn patch_me(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::PATCH, "/api/users/me", Some(tok), body)
        .await
}

async fn me(t: &TestApp, tok: &str) -> Value {
    let r = t.get("/api/auth/me", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn put_banner(t: &TestApp, tok: Option<&str>, bytes: &[u8]) -> Resp {
    t.multipart(
        Method::PUT,
        "/api/users/me/banner",
        tok,
        &[Part::File("banner", "banner.png", "image/png", bytes)],
    )
    .await
}

async fn delete_banner(t: &TestApp, tok: &str) -> Resp {
    t.send(
        Method::DELETE,
        "/api/users/me/banner",
        Some(tok),
        None,
        vec![],
        &[],
    )
    .await
}

async fn put_avatar(t: &TestApp, tok: &str) -> Resp {
    t.multipart(
        Method::PUT,
        "/api/users/me/avatar",
        Some(tok),
        &[Part::File("avatar", "a.png", "image/png", &png_bytes())],
    )
    .await
}

fn banner_file(t: &TestApp, uid: &str) -> std::path::PathBuf {
    t.state.storage.banners_dir().join(format!("{uid}.jpg"))
}

fn stored_dims(t: &TestApp, uid: &str) -> (u32, u32) {
    let bytes = std::fs::read(banner_file(t, uid)).unwrap();
    assert!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]), "not a JPEG");
    let img = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();
    (img.width(), img.height())
}

async fn banner_version(t: &TestApp, uid: &str) -> i64 {
    sqlx::query_scalar("SELECT banner_version FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn report(t: &TestApp, tok: &str, target_type: &str, id: &str) -> Resp {
    t.json(
        Method::POST,
        "/api/reports",
        Some(tok),
        json!({ "targetType": target_type, "targetId": id, "reason": "offensive" }),
    )
    .await
}

async fn resolve(t: &TestApp, admin: &str, id: &str, action: &str) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/admin/reports/{id}/resolve"),
        Some(admin),
        json!({ "action": action }),
    )
    .await
}

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0023() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let dir = common::test_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        data.join("webgame.db").to_string_lossy().replace('\\', "/")
    );
    {
        let opts = SqliteConnectOptions::from_str(&url)
            .unwrap()
            .foreign_keys(true);
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let mut m = sqlx::migrate!("./migrations");
        m.migrations = std::borrow::Cow::Owned(
            m.migrations
                .iter()
                .filter(|x| x.version <= 23)
                .cloned()
                .collect(),
        );
        m.run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, username_lower, email, email_lower, \
             password_hash, display_name, created_at, role) VALUES \
             ('u1', 'Una', 'una', 'u1@x', 'u1@x', 'h', 'Una', '2026-01-01T00:00:00.000Z', 'user')",
        )
        .execute(&db)
        .await
        .unwrap();
        db.close().await;
    }

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    let (ext, version, links): (Option<String>, i64, String) =
        sqlx::query_as("SELECT banner_ext, banner_version, links_json FROM users WHERE id = 'u1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(ext, None);
    assert_eq!(version, 0);
    assert_eq!(links, "[]");

    let token = webgame_server::auth::create_token(&state.config.jwt_secret, "u1").unwrap();
    let router = webgame_server::app(state.clone());
    let res = tower::ServiceExt::oneshot(
        router,
        axum::http::Request::builder()
            .uri("/api/auth/me")
            .header("host", "localhost:8080")
            .header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = http_body_util::BodyExt::collect(res.into_body())
        .await
        .unwrap()
        .to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["bannerUrl"], Value::Null);
    assert_eq!(v["links"], json!([]));

    let ok: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(ok, "ok");
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

#[tokio::test]
async fn links_are_validated_normalised_and_kept() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;

    // Fresh users: no banner, no links.
    let v = me(&t, &tok).await;
    assert_eq!(v["bannerUrl"], Value::Null);
    assert_eq!(v["links"], json!([]));

    let r = patch_me(
        &t,
        &tok,
        json!({ "links": [{ "label": " Site ", "url": "HTTPS://Example.com/a?b#c" }] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let want = json!([{ "label": "Site", "url": "https://Example.com/a?b#c" }]);
    assert_eq!(r.json()["links"], want);

    // Omitted and null keep them.
    let r = patch_me(&t, &tok, json!({ "bio": "hi" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["links"], want);
    let r = patch_me(&t, &tok, json!({ "links": null })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["links"], want);
    // Public profile shows them too.
    let r = t.get("/api/users/mia", None).await;
    assert_eq!(r.json()["user"]["links"], want);

    // Missing label, unknown keys ignored, order kept.
    let r = patch_me(
        &t,
        &tok,
        json!({ "links": [
            { "url": "https://b.example.com", "extra": 1 },
            { "label": "A", "url": "http://a.example.com:8080/x" }
        ] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json()["links"],
        json!([
            { "label": "", "url": "https://b.example.com" },
            { "label": "A", "url": "http://a.example.com:8080/x" }
        ])
    );

    // [] clears them.
    let r = patch_me(&t, &tok, json!({ "links": [] })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["links"], json!([]));

    // Not an array → JSON extractor 422.
    let r = patch_me(&t, &tok, json!({ "links": "https://x.com" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(r.error_code(), "validation");
}

#[tokio::test]
async fn link_error_messages() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    let one = |label: &str, url: &str| json!({ "links": [{ "label": label, "url": url }] });

    let four: Vec<Value> = (0..4)
        .map(|_| json!({ "label": "", "url": "https://x.com" }))
        .collect();
    assert_422(
        &patch_me(&t, &tok, json!({ "links": four })).await,
        "links must have at most 3 items",
    );

    let long = format!("https://x.com/{}", "a".repeat(201 - 14));
    assert_eq!(long.len(), 201);
    assert_422(
        &patch_me(&t, &tok, one("", &long)).await,
        "links[0].url must be at most 200 characters",
    );

    for bad in [
        "javascript:alert(1)",
        "ftp://x.com",
        "https://user@x.com",
        "https://localhost",
        "https://-x.com",
        "https://x.com/ a",
        "https://exämple.com",
        "https://x.com:123456",
        "",
    ] {
        let r = patch_me(&t, &tok, one("", bad)).await;
        assert_422(&r, URL_MSG);
    }

    assert_422(
        &patch_me(&t, &tok, one(&"a".repeat(31), "https://x.com")).await,
        "links[0].label must be at most 30 characters",
    );
    assert_422(
        &patch_me(&t, &tok, one("a\u{0007}b", "https://x.com")).await,
        "links[0].label must not contain control characters",
    );
    // C1 controls and bidi / invisible formatting characters (display spoofing).
    for label in [
        "a\u{0085}b",
        "Site\u{202E}moc.live",
        "a\u{200B}b",
        "a\u{FEFF}b",
    ] {
        assert_422(
            &patch_me(&t, &tok, one(label, "https://x.com")).await,
            "links[0].label must not contain control characters",
        );
    }
    // 0-based index of the failing item.
    let r = patch_me(
        &t,
        &tok,
        json!({ "links": [
            { "label": "ok", "url": "https://x.com" },
            { "label": "bad", "url": "ftp://x.com" }
        ] }),
    )
    .await;
    assert_422(
        &r,
        "links[1].url must be a full http:// or https:// address",
    );

    // Nothing was stored by any of the failures.
    assert_eq!(me(&t, &tok).await["links"], json!([]));
}

#[tokio::test]
async fn patch_me_validates_every_field_before_writing() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;

    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": "New", "links": [{ "label": "", "url": "ftp://x.com" }] }),
    )
    .await;
    assert_422(&r, URL_MSG);
    assert_eq!(me(&t, &tok).await["displayName"], "mia");

    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": "New", "bio": "b".repeat(1001) }),
    )
    .await;
    assert_422(&r, "bio must be at most 1000 characters");
    let v = me(&t, &tok).await;
    assert_eq!(v["displayName"], "mia");
    assert_eq!(v["bio"], "");

    // displayName is checked first.
    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": " ", "bio": "b".repeat(1001) }),
    )
    .await;
    assert_422(&r, "displayName must be 1-50 characters");

    // All three valid → all written.
    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": " Mia ", "bio": " Hello ", "links": [{ "label": "", "url": "https://mia.dev" }] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["displayName"], "Mia");
    assert_eq!(v["bio"], "Hello");
    assert_eq!(
        v["links"],
        json!([{ "label": "", "url": "https://mia.dev" }])
    );

    // Anonymous.
    let r = t
        .json(Method::PATCH, "/api/users/me", None, json!({ "links": [] }))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

#[tokio::test]
async fn banner_upload_crops_scales_and_versions() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;

    let r = put_banner(&t, Some(&tok), &png(3000, 500)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["bannerUrl"], format!("/media/banners/{uid}.jpg?v=1"));
    assert_eq!(v["id"], uid.as_str());
    assert_eq!(stored_dims(&t, &uid), (1500, 500));

    let r = put_banner(&t, Some(&tok), &jpeg(900, 900)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json()["bannerUrl"],
        format!("/media/banners/{uid}.jpg?v=2")
    );
    assert_eq!(stored_dims(&t, &uid), (900, 300));

    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(stored_dims(&t, &uid), (600, 200));
    assert_eq!(banner_version(&t, &uid).await, 3);

    // Public profile and /auth/me agree.
    let r = t.get("/api/users/mia", None).await;
    assert_eq!(
        r.json()["user"]["bannerUrl"],
        format!("/media/banners/{uid}.jpg?v=3")
    );

    // Served with the F005 media headers.
    let r = t.get(&format!("/media/banners/{uid}.jpg?v=3"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("content-security-policy"), "sandbox");
    assert_eq!(r.header("cache-control"), "public, max-age=3600");
    assert_eq!(r.header("content-type"), "image/jpeg");
    assert!(r.body.starts_with(&[0xFF, 0xD8, 0xFF]));
    let r = t.get("/media/banners/nobody.jpg", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.header("cache-control"), "no-store");
}

#[tokio::test]
async fn banner_second_upload_and_delete_are_versioned() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;

    // Deleting nothing is fine and doesn't bump the version.
    let r = delete_banner(&t, &tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bannerUrl"], Value::Null);
    assert_eq!(banner_version(&t, &uid).await, 0);

    for v in 1..=2 {
        let r = put_banner(&t, Some(&tok), &png(1200, 400)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(
            r.json()["bannerUrl"],
            format!("/media/banners/{uid}.jpg?v={v}")
        );
    }
    assert!(banner_file(&t, &uid).exists());

    let r = delete_banner(&t, &tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bannerUrl"], Value::Null);
    assert!(!banner_file(&t, &uid).exists());
    assert_eq!(banner_version(&t, &uid).await, 3);
    let r = t.get(&format!("/media/banners/{uid}.jpg"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    let r = delete_banner(&t, &tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(banner_version(&t, &uid).await, 3);

    // Anonymous delete.
    let r = t
        .send(
            Method::DELETE,
            "/api/users/me/banner",
            None,
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn banner_errors() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;

    assert_422(
        &put_banner(&t, Some(&tok), &png(500, 500)).await,
        "banner must be at least 600×200 pixels after cropping to 3:1",
    );
    assert_422(
        &put_banner(&t, Some(&tok), &png(50, 50)).await,
        "image must be between 64 and 4096 pixels per side",
    );
    assert_422(
        &put_banner(&t, Some(&tok), b"definitely not an image at all").await,
        "banner must be a PNG, JPEG or WebP image",
    );
    let mut big = png_bytes();
    big.resize(2 * 1024 * 1024 + 1, 0);
    assert_err(
        &put_banner(&t, Some(&tok), &big).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        "banner must be at most 2MB",
    );
    // Valid magic, broken pixels.
    assert_422(
        &put_banner(&t, Some(&tok), &png_bytes()).await,
        "image could not be decoded",
    );
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/banner",
            Some(&tok),
            &[Part::Text("other", "x")],
        )
        .await;
    assert_422(&r, "banner file is required");

    let r = put_banner(&t, None, &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // None of the failures stored anything.
    assert!(!banner_file(&t, &uid).exists());
    assert_eq!(banner_version(&t, &uid).await, 0);
    assert_eq!(me(&t, &tok).await["bannerUrl"], Value::Null);
}

#[tokio::test]
async fn banner_strips_metadata() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;
    let src = png_with_text(900, 300);
    assert!(contains(&src, MARKER));
    let r = put_banner(&t, Some(&tok), &src).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let stored = std::fs::read(banner_file(&t, &uid)).unwrap();
    assert!(!contains(&stored, MARKER));
    assert!(!contains(&stored, b"Comment"));
}

#[tokio::test]
async fn banner_shares_the_image_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("mia").await;
    for _ in 0..20 {
        let r = put_avatar(&t, &tok).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    assert_eq!(r.error_code(), "rate_limited");
    // The bucket refills with time.
    t.clock.advance(std::time::Duration::from_secs(3600));
    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

#[tokio::test]
async fn banner_busy_when_no_image_slot() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;
    let permits = t
        .state
        .image_slots
        .clone()
        .acquire_many_owned(webgame_server::IMAGE_SLOTS as u32)
        .await
        .unwrap();
    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_err(
        &r,
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "The server is busy, try again in a few seconds",
    );
    assert_eq!(r.header("retry-after"), "5");
    drop(permits);
    assert_eq!(banner_version(&t, &uid).await, 0);
    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

#[tokio::test]
async fn busy_banner_upload_refunds_its_image_token() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("mia").await;
    // 19 of the 20 Limit::Image tokens.
    for _ in 0..19 {
        let r = put_avatar(&t, &tok).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    let permits = t
        .state
        .image_slots
        .clone()
        .acquire_many_owned(webgame_server::IMAGE_SLOTS as u32)
        .await
        .unwrap();
    for _ in 0..3 {
        let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{}", r.text());
    }
    drop(permits);
    // The busy attempts were refunded, so the 20th token is still there.
    let r = put_banner(&t, Some(&tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = put_avatar(&t, &tok).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async fn post_shot(t: &TestApp, tok: &str, gid: &str) {
    let r = t
        .multipart(
            Method::POST,
            &format!("/api/games/{gid}/screenshots"),
            Some(tok),
            &[Part::File("image", "s.png", "image/png", &png(64, 64))],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
}

async fn mk_collection(t: &TestApp, tok: &str, visibility: &str, gid: &str) {
    let r = t
        .json(
            Method::POST,
            "/api/collections",
            Some(tok),
            json!({ "title": format!("C {visibility}"), "visibility": visibility }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let cid = s(&r.json()["id"]);
    let r = t
        .send(
            Method::PUT,
            &format!("/api/collections/{cid}/games/{gid}"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn add_achievements(t: &TestApp, uid: &str, gid: &str, n: usize) {
    for i in 0..n {
        sqlx::query(
            "INSERT INTO achievements (game_id, ach_id, position, name) VALUES (?, ?, ?, ?)",
        )
        .bind(gid)
        .bind(format!("a{i}"))
        .bind(i as i64)
        .bind(format!("A{i}"))
        .execute(&t.state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_achievements (user_id, game_id, ach_id, unlocked_at) \
             VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .bind(uid)
        .bind(gid)
        .bind(format!("a{i}"))
        .execute(&t.state.db)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn profile_stats_follow_list_visibility() {
    let t = setup().await;
    let (u_tok, uid) = t.register("uma").await;
    let (p_tok, _) = t.register("pat").await;
    let g1 = s(&t.create_game(&u_tok, "One", "", true).await["id"]);
    let g2 = s(&t.create_game(&u_tok, "Two", "", true).await["id"]);
    let g3 = s(&t.create_game(&u_tok, "Three", "", false).await["id"]);
    for (gid, plays) in [(&g1, 5), (&g2, 7), (&g3, 100)] {
        sqlx::query("UPDATE games SET plays = ? WHERE id = ?")
            .bind(plays)
            .bind(gid)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    post_shot(&t, &u_tok, &g1).await;
    post_shot(&t, &u_tok, &g3).await;
    mk_collection(&t, &u_tok, "public", &g1).await;
    mk_collection(&t, &u_tok, "private", &g1).await;
    add_achievements(&t, &uid, &g1, 2).await;
    add_achievements(&t, &uid, &g3, 1).await;

    let cases: [(Option<&str>, Value, i64); 3] = [
        (
            None,
            json!({ "plays": 12, "achievements": 2, "screenshots": 1, "collections": 1, "posts": 0 }),
            2,
        ),
        (
            Some(&p_tok),
            json!({ "plays": 12, "achievements": 2, "screenshots": 1, "collections": 1, "posts": 0 }),
            2,
        ),
        (
            Some(&u_tok),
            json!({ "plays": 112, "achievements": 3, "screenshots": 2, "collections": 2, "posts": 0 }),
            3,
        ),
    ];
    for (tok, stats, total) in cases {
        let r = t.get("/api/users/UMA", tok).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        let v = r.json();
        assert_eq!(v["stats"], stats, "{tok:?}");
        assert_eq!(v["gamesTotal"], total);
        // Each count equals its list endpoint's total for the same viewer.
        let shots = t.get("/api/users/uma/screenshots", tok).await.json();
        assert_eq!(v["stats"]["screenshots"], shots["total"]);
        let cols = t.get("/api/users/uma/collections", tok).await.json();
        assert_eq!(v["stats"]["collections"], cols["total"]);
        let achs = t.get("/api/users/uma/achievements?limit=100", tok).await;
        assert_eq!(achs.status, StatusCode::OK, "{}", achs.text());
        let achs = achs.json();
        let n = achs
            .as_array()
            .or_else(|| achs["items"].as_array())
            .map(|a| a.len() as i64)
            .unwrap();
        assert_eq!(v["stats"]["achievements"], n);
    }

    // A user with nothing: all zero.
    let v = t.get("/api/users/pat", None).await.json();
    assert_eq!(
        v["stats"],
        json!({ "plays": 0, "achievements": 0, "screenshots": 0, "collections": 0, "posts": 0 })
    );
}

// ---------------------------------------------------------------------------
// Reports and clearProfile
// ---------------------------------------------------------------------------

#[tokio::test]
async fn user_reports_and_action_rules() {
    let t = admin_app().await;
    let (admin, _) = t.register("boss").await;
    let (u_tok, uid) = t.register("uma").await;
    let (p_tok, _) = t.register("pat").await;

    let r = report(&t, &p_tok, "user", &uid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v = r.json();
    assert_eq!(v["targetType"], "user");
    assert_eq!(v["targetId"], uid.as_str());
    assert_eq!(v["targetPreview"], "@uma");
    assert_eq!(v["targetGameId"], Value::Null);
    assert_eq!(v["targetImageUrl"], Value::Null);
    let rid = s(&v["id"]);

    let r = report(&t, &p_tok, "user", &uid).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text());
    assert_422(
        &report(&t, &u_tok, "user", &uid).await,
        "You can't report yourself",
    );
    assert_err(
        &report(&t, &p_tok, "user", "no-such-user").await,
        StatusCode::NOT_FOUND,
        "not_found",
        "User not found",
    );
    assert_422(
        &report(&t, &p_tok, "bogus", &uid).await,
        "targetType must be \"game\", \"comment\", \"screenshot\", \"collection\", \"user\" or \"post\"",
    );

    let user_msg = "action must be \"dismiss\" or \"clearProfile\" for user reports";
    assert_422(&resolve(&t, &admin, &rid, "delete").await, user_msg);
    assert_422(&resolve(&t, &admin, &rid, "unpublish").await, user_msg);
    assert_422(
        &resolve(&t, &admin, &rid, "bogus").await,
        "action must be \"dismiss\", \"unpublish\", \"delete\" or \"clearProfile\"",
    );

    // clearProfile on other target types.
    let gid = s(&t.create_game(&u_tok, "Game", "", true).await["id"]);
    let r = report(&t, &p_tok, "game", &gid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let grid = s(&r.json()["id"]);
    assert_422(
        &resolve(&t, &admin, &grid, "clearProfile").await,
        "clearProfile is only valid for user reports",
    );
    assert_422(
        &resolve(&t, &admin, &grid, "bogus").await,
        "action must be \"dismiss\", \"unpublish\", \"delete\" or \"clearProfile\"",
    );

    // Not admin.
    let r = resolve(&t, &p_tok, &rid, "dismiss").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());

    // Dismiss works and is then a 409 (after validation).
    let r = resolve(&t, &admin, &rid, "dismiss").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["resolution"], "dismiss");
    assert_422(&resolve(&t, &admin, &rid, "delete").await, user_msg);
    let r = resolve(&t, &admin, &rid, "clearProfile").await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text());

    // The admin list shows the user row.
    let r = t.get("/api/admin/reports", Some(&admin)).await;
    let items = r.json()["items"].as_array().unwrap().clone();
    assert!(items.iter().any(|i| i["id"] == rid.as_str()
        && i["targetType"] == "user"
        && i["targetPreview"] == "@uma"));
}

#[tokio::test]
async fn clear_profile_resets_the_profile_and_keeps_content() {
    let t = admin_app().await;
    let (admin, _) = t.register("boss").await;
    let (u_tok, uid) = t.register("uma").await;
    let (p_tok, _) = t.register("pat").await;
    let (q_tok, _) = t.register("quin").await;

    let r = patch_me(
        &t,
        &u_tok,
        json!({ "displayName": "Bad Name", "bio": "bad bio",
                "links": [{ "label": "spam", "url": "https://spam.example.com" }] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(put_avatar(&t, &u_tok).await.status, StatusCode::OK);
    let r = put_banner(&t, Some(&u_tok), &png(600, 200)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let avatar_file = t.state.storage.avatars_dir().join(format!("{uid}.png"));
    assert!(avatar_file.exists());
    assert!(banner_file(&t, &uid).exists());
    let gid = s(&t.create_game(&u_tok, "Kept", "", true).await["id"]);

    let r = report(&t, &p_tok, "user", &uid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rid = s(&r.json()["id"]);
    let r = report(&t, &q_tok, "user", &uid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rid2 = s(&r.json()["id"]);

    let r = resolve(&t, &admin, &rid, "clearProfile").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["status"], "resolved");
    assert_eq!(v["resolution"], "clearProfile");

    let r = t.get("/api/admin/reports?status=open", Some(&admin)).await;
    let open = r.json()["items"].as_array().unwrap().clone();
    assert!(!open.iter().any(|i| i["id"] == rid2.as_str()));
    let r = t
        .get("/api/admin/reports?status=resolved", Some(&admin))
        .await;
    let resolved = r.json()["items"].as_array().unwrap().clone();
    let second = resolved.iter().find(|i| i["id"] == rid2.as_str()).unwrap();
    assert_eq!(second["resolution"], "clearProfile");

    let v = me(&t, &u_tok).await;
    assert_eq!(v["displayName"], "uma");
    assert_eq!(v["bio"], "");
    assert_eq!(v["links"], json!([]));
    assert_eq!(v["avatarUrl"], Value::Null);
    assert_eq!(v["bannerUrl"], Value::Null);
    assert!(!avatar_file.exists());
    assert!(!banner_file(&t, &uid).exists());
    let (av, bv): (i64, i64) =
        sqlx::query_as("SELECT avatar_version, banner_version FROM users WHERE id = ?")
            .bind(&uid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!((av, bv), (2, 2));

    // Games stay.
    let r = t.get(&format!("/api/games/{gid}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["title"], "Kept");
    assert_eq!(t.get("/api/users/uma", None).await.json()["gamesTotal"], 1);

    // A user who no longer exists: a no-op that still resolves the report.
    let (z_tok, zid) = t.register("zed").await;
    let r = report(&t, &p_tok, "user", &zid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let zrid = s(&r.json()["id"]);
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&zid)
        .execute(&t.state.db)
        .await
        .unwrap();
    drop(z_tok);
    let r = resolve(&t, &admin, &zrid, "clearProfile").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["resolution"], "clearProfile");
}
