//! F005: screenshot upload / re-encode, gallery, delete, reports, cleanup and migration.

mod common;

use std::io::Cursor;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use serde_json::{Value, json};
use webgame_server::sweep_stale_files;

const MARKER: &[u8] = b"WEBGAME-SECRET-MARKER";

// ---------------------------------------------------------------------------
// Image fixtures
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

fn webp(w: u32, h: u32) -> Vec<u8> {
    encode(&rgb(w, h), ImageFormat::WebP)
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

/// A JPEG with an EXIF APP1 segment (carrying MARKER) right after SOI.
fn jpeg_with_exif(w: u32, h: u32) -> Vec<u8> {
    let src = jpeg(w, h);
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(MARKER);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&src[2..]);
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn game_id(t: &TestApp, tok: &str, published: bool) -> String {
    t.create_game(tok, "Shots", "", published).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn post_parts(t: &TestApp, tok: Option<&str>, gid: &str, parts: &[Part<'_>]) -> Resp {
    t.multipart(
        Method::POST,
        &format!("/api/games/{gid}/screenshots"),
        tok,
        parts,
    )
    .await
}

async fn post(t: &TestApp, tok: &str, gid: &str, img: &[u8], caption: Option<&str>) -> Resp {
    let mut parts = vec![Part::File("image", "shot.png", "image/png", img)];
    if let Some(c) = caption {
        parts.push(Part::Text("caption", c));
    }
    post_parts(t, Some(tok), gid, &parts).await
}

async fn post_ok(t: &TestApp, tok: &str, gid: &str, caption: Option<&str>) -> Value {
    let r = post(t, tok, gid, &png(64, 64), caption).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn list(t: &TestApp, tok: Option<&str>, gid: &str, query: &str) -> Resp {
    t.get(&format!("/api/games/{gid}/screenshots{query}"), tok)
        .await
}

async fn delete(t: &TestApp, tok: Option<&str>, id: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/screenshots/{id}"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

fn stored(t: &TestApp, name: &str) -> std::path::PathBuf {
    t.state.storage.screenshots_dir().join(name)
}

fn files_of(t: &TestApp, id: &str) -> Vec<String> {
    ["png", "jpg"]
        .iter()
        .map(|e| format!("{id}.{e}"))
        .chain([format!("{id}_t.jpg")])
        .filter(|n| stored(t, n).exists())
        .collect()
}

fn sid(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
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

// ---------------------------------------------------------------------------
// Upload, formats, metadata
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_png_strips_text_chunks() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    let input = png_with_text(200, 100);
    assert!(contains(&input, MARKER));
    let r = post(&t, &a, &gid, &input, Some("  Finally!  ")).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v = r.json();
    let id = sid(&v);
    assert_eq!(v["gameId"], gid);
    assert_eq!(v["caption"], "Finally!");
    assert_eq!(v["imageUrl"], format!("/media/screenshots/{id}.png"));
    assert_eq!(v["thumbUrl"], format!("/media/screenshots/{id}_t.jpg"));
    assert_eq!(v["width"], 200);
    assert_eq!(v["height"], 100);
    assert_eq!(v["gameVersion"], 1);
    assert_eq!(v["canDelete"], true);
    assert_eq!(v["author"]["username"], "ana");
    assert!(v["createdAt"].as_str().unwrap().ends_with('Z'));

    let full = std::fs::read(stored(&t, &format!("{id}.png"))).unwrap();
    assert!(full.starts_with(b"\x89PNG"));
    assert!(!contains(&full, MARKER));
    assert!(!contains(&full, b"tEXt"));
    let thumb = std::fs::read(stored(&t, &format!("{id}_t.jpg"))).unwrap();
    assert!(thumb.starts_with(&[0xFF, 0xD8]));
    // Small images are not upscaled.
    assert_eq!(
        image::load_from_memory(&thumb)
            .unwrap()
            .into_rgb8()
            .dimensions(),
        (200, 100)
    );

    // Served with the media headers.
    let r = t
        .send(
            Method::GET,
            &format!("/media/screenshots/{id}.png"),
            None,
            None,
            vec![],
            &[("origin", "https://elsewhere.example")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, full);
    assert_eq!(
        r.header("cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("content-security-policy"), "sandbox");
    assert_eq!(r.header("access-control-allow-origin"), "*");
    // A missing file is a 404 that is not cached as immutable.
    let r = t.get("/media/screenshots/nope.png", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_ne!(
        r.header("cache-control"),
        "public, max-age=31536000, immutable"
    );
}

#[tokio::test]
async fn upload_jpeg_strips_exif_and_thumbs() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    let input = jpeg_with_exif(1000, 500);
    assert!(contains(&input, MARKER));
    let r = post(&t, &a, &gid, &input, None).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v = r.json();
    let id = sid(&v);
    assert_eq!(v["imageUrl"], format!("/media/screenshots/{id}.jpg"));
    assert_eq!(v["caption"], "");
    assert_eq!(
        (v["width"].as_i64(), v["height"].as_i64()),
        (Some(1000), Some(500))
    );
    let full = std::fs::read(stored(&t, &format!("{id}.jpg"))).unwrap();
    assert!(!contains(&full, MARKER));
    assert!(!contains(&full, b"Exif"));
    let thumb = std::fs::read(stored(&t, &format!("{id}_t.jpg"))).unwrap();
    assert!(!contains(&thumb, MARKER));
    assert_eq!(
        image::load_from_memory(&thumb)
            .unwrap()
            .into_rgb8()
            .dimensions(),
        (480, 240)
    );
}

#[tokio::test]
async fn upload_webp_becomes_jpeg_and_alpha_is_flattened() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    let r = post(&t, &a, &gid, &webp(300, 300), None).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let id = sid(&r.json());
    assert_eq!(
        files_of(&t, &id),
        vec![format!("{id}.jpg"), format!("{id}_t.jpg")]
    );

    // Transparent white → black (alpha composited on black), opaque pixels kept.
    let img = RgbaImage::from_fn(64, 64, |x, _| {
        if x < 32 {
            Rgba([255, 255, 255, 0])
        } else {
            Rgba([10, 200, 30, 255])
        }
    });
    let bytes = encode(&DynamicImage::ImageRgba8(img), ImageFormat::Png);
    let r = post(&t, &a, &gid, &bytes, None).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let id = sid(&r.json());
    let out = image::open(stored(&t, &format!("{id}.png"))).unwrap();
    assert!(!out.color().has_alpha());
    let out = out.into_rgb8();
    assert_eq!(out.get_pixel(0, 0).0, [0, 0, 0]);
    assert_eq!(out.get_pixel(63, 0).0, [10, 200, 30]);
}

#[tokio::test]
async fn size_and_format_limits() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;

    for (w, h) in [(63, 63), (4097, 10), (64, 63)] {
        let r = post(&t, &a, &gid, &png(w, h), None).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{w}x{h}");
        assert_eq!(
            r.json()["error"]["message"],
            "image must be between 64 and 4096 pixels per side"
        );
    }
    // Header OK, pixel data truncated → decode failure.
    let mut broken = png(200, 200);
    broken.truncate(broken.len() / 2);
    let r = post(&t, &a, &gid, &broken, None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.json()["error"]["message"], "image could not be decoded");
    // Magic bytes only.
    let r = post(&t, &a, &gid, &png_bytes(), None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.json()["error"]["message"], "image could not be decoded");
    // > 2 MB → 413.
    let mut big = png_bytes();
    big.resize(2 * 1024 * 1024 + 1, 0);
    let r = post(&t, &a, &gid, &big, None).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.text());
    // Not an image by magic bytes.
    let r = post(
        &t,
        &a,
        &gid,
        b"<!doctype html><script>alert(1)</script>",
        None,
    )
    .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Missing / empty image.
    let r = post_parts(&t, Some(&a), &gid, &[Part::Text("caption", "hi")]).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.json()["error"]["message"], "image file is required");
    let r = post(&t, &a, &gid, b"", None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Anonymous → 401.
    let img = png(64, 64);
    let r = post_parts(
        &t,
        None,
        &gid,
        &[Part::File("image", "a.png", "image/png", &img)],
    )
    .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // Nothing was stored.
    let r = list(&t, None, &gid, "").await;
    assert_eq!(r.json()["total"], 0);
    assert_eq!(
        std::fs::read_dir(t.state.storage.screenshots_dir())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn caption_rules() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    let img = png(64, 64);

    let max = "é".repeat(140);
    let r = post(&t, &a, &gid, &img, Some(&format!("  {max} "))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(r.json()["caption"], max);

    for bad in [
        "é".repeat(141),
        "line\nbreak".into(),
        "tab\there".into(),
        "bidi \u{202E}evil".into(),
        "isolate \u{2066}x".into(),
        "nul\u{0}".into(),
        "x".repeat(1025),
    ] {
        let r = post(&t, &a, &gid, &img, Some(&bad)).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad:?}");
        assert_eq!(r.error_code(), "validation");
    }

    // Unknown fields are ignored.
    let r = post_parts(
        &t,
        Some(&a),
        &gid,
        &[
            Part::Text("extra", "whatever"),
            Part::File("image", "a.png", "image/png", &img),
        ],
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(list(&t, None, &gid, "").await.json()["total"], 2);
}

// ---------------------------------------------------------------------------
// Visibility, cap, rate limit, decode slots
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unpublished_game_visibility() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (bob, _) = t.register("bob").await;
    let gid = game_id(&t, &owner, false).await;
    let img = png(64, 64);

    assert_eq!(list(&t, None, &gid, "").await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        list(&t, Some(&bob), &gid, "").await.status,
        StatusCode::NOT_FOUND
    );
    let r = post(&t, &bob, &gid, &img, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    let r = post(&t, &owner, &gid, &img, None).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let r = list(&t, Some(&owner), &gid, "").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["total"], 1);

    // Unknown game and bad paging.
    assert_eq!(
        list(&t, None, "nope", "").await.status,
        StatusCode::NOT_FOUND
    );
    let r = post(&t, &owner, "nope", &img, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = list(&t, Some(&owner), &gid, "?page=abc").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn per_user_per_game_cap_and_decode_slots() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let (b, _) = t.register("bob").await;
    let gid = game_id(&t, &a, true).await;
    for _ in 0..20 {
        post_ok(&t, &a, &gid, None).await;
    }
    let r = post(&t, &a, &gid, &png(64, 64), None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        r.json()["error"]["message"],
        "You can post at most 20 screenshots per game"
    );
    // Other users and other games have their own counts.
    post_ok(&t, &b, &gid, None).await;
    let other = game_id(&t, &a, true).await;
    post_ok(&t, &a, &other, None).await;

    // Both decode slots busy → 503 + Retry-After: 5.
    let permits = t
        .state
        .image_slots
        .clone()
        .try_acquire_many_owned(2)
        .unwrap();
    let r = post(&t, &b, &gid, &png(64, 64), None).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.error_code(), "unavailable");
    assert_eq!(r.header("retry-after"), "5");
    drop(permits);
    post_ok(&t, &b, &gid, None).await;
    assert_eq!(list(&t, None, &gid, "").await.json()["total"], 22);
}

#[tokio::test]
async fn screenshot_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    for _ in 0..10 {
        post_ok(&t, &a, &gid, None).await;
    }
    let r = post(&t, &a, &gid, &png(64, 64), None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(r.header("retry-after").parse::<u64>().unwrap() >= 1);
}

// ---------------------------------------------------------------------------
// Listing and delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_paging_order_and_can_delete() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let (owner, _) = t.register("owen").await;
    let (ana, _) = t.register("ana").await;
    let (bob, _) = t.register("bob").await;
    let (boss, _) = t.register("boss").await;
    let gid = game_id(&t, &owner, true).await;
    let mut ids = Vec::new();
    for (i, c) in ["one", "two", "three"].iter().enumerate() {
        let id = sid(&post_ok(&t, &ana, &gid, Some(c)).await);
        sqlx::query("UPDATE screenshots SET created_at = ? WHERE id = ?")
            .bind(format!("2026-11-1{i}T00:00:00.000Z"))
            .bind(&id)
            .execute(&t.state.db)
            .await
            .unwrap();
        ids.push(id);
    }

    let r = list(&t, None, &gid, "?perPage=2").await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 2);
    let got: Vec<&str> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    assert_eq!(got, vec![ids[2].as_str(), ids[1].as_str()]);
    assert_eq!(v["items"][0]["caption"], "three");
    assert_eq!(v["items"][0]["canDelete"], false);
    let v = list(&t, None, &gid, "?perPage=2&page=2").await.json();
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["items"][0]["id"], ids[0]);
    assert_eq!(
        list(&t, None, &gid, "?perPage=500").await.json()["perPage"],
        50
    );
    assert_eq!(list(&t, None, &gid, "").await.json()["perPage"], 12);

    for (tok, expect) in [(&ana, true), (&owner, true), (&boss, true), (&bob, false)] {
        let v = list(&t, Some(tok), &gid, "").await.json();
        for item in v["items"].as_array().unwrap() {
            assert_eq!(item["canDelete"], expect);
        }
    }
}

#[tokio::test]
async fn delete_permissions_and_files() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let (owner, _) = t.register("owen").await;
    let (ana, _) = t.register("ana").await;
    let (bob, _) = t.register("bob").await;
    let (boss, _) = t.register("boss").await;
    let gid = game_id(&t, &owner, true).await;
    let s1 = sid(&post_ok(&t, &ana, &gid, None).await);
    let s2 = sid(&post_ok(&t, &ana, &gid, None).await);
    let s3 = sid(&post_ok(&t, &ana, &gid, None).await);
    assert_eq!(files_of(&t, &s1).len(), 2);

    assert_eq!(delete(&t, None, &s1).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        delete(&t, Some(&bob), &s1).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(&t, Some(&bob), "nope").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        delete(&t, Some(&ana), &s1).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(files_of(&t, &s1).is_empty());
    assert_eq!(
        delete(&t, Some(&ana), &s1).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        delete(&t, Some(&owner), &s2).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(files_of(&t, &s2).is_empty());
    assert_eq!(
        delete(&t, Some(&boss), &s3).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(files_of(&t, &s3).is_empty());
    assert_eq!(list(&t, None, &gid, "").await.json()["total"], 0);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[tokio::test]
async fn screenshot_reports() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let (ana, _) = t.register("ana").await;
    let (bob, _) = t.register("bob").await;
    let (boss, _) = t.register("boss").await;
    let gid = game_id(&t, &ana, true).await;
    let captioned = post_ok(&t, &ana, &gid, Some("Nice view")).await;
    let s1 = sid(&captioned);
    let s2 = sid(&post_ok(&t, &ana, &gid, None).await);

    let r = report(&t, &bob, "screenshot", &s1).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rep1 = r.json();
    assert_eq!(rep1["targetType"], "screenshot");
    assert_eq!(rep1["targetGameId"], gid);
    assert_eq!(rep1["targetPreview"], "Nice view");
    assert_eq!(rep1["targetImageUrl"], captioned["thumbUrl"]);
    let r = report(&t, &bob, "screenshot", &s1).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let rep2 = report(&t, &bob, "screenshot", &s2).await.json();
    assert_eq!(rep2["targetPreview"], "Screenshot by ana");
    assert_eq!(
        report(&t, &bob, "screenshot", "nope").await.status,
        StatusCode::NOT_FOUND
    );
    let game_rep = report(&t, &bob, "game", &gid).await.json();
    assert!(game_rep["targetImageUrl"].is_null());

    // Admin list carries targetImageUrl on every report.
    let v = t.get("/api/admin/reports", Some(&boss)).await.json();
    let by_id = |v: &Value, id: &Value| -> Value {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == *id)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        by_id(&v, &rep1["id"])["targetImageUrl"],
        captioned["thumbUrl"]
    );
    assert!(by_id(&v, &game_rep["id"])["targetImageUrl"].is_null());

    // Resolve: unpublish → 422, delete removes the screenshot.
    let r = resolve(&t, &boss, rep1["id"].as_str().unwrap(), "unpublish").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = resolve(&t, &boss, rep1["id"].as_str().unwrap(), "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["status"], "resolved");
    assert_eq!(v["resolution"], "delete");
    assert!(v["targetImageUrl"].is_null());
    assert!(files_of(&t, &s1).is_empty());
    assert_eq!(list(&t, None, &gid, "").await.json()["total"], 1);

    // Any delete auto-resolves the screenshot's open reports.
    assert_eq!(
        delete(&t, Some(&ana), &s2).await.status,
        StatusCode::NO_CONTENT
    );
    let v = t.get("/api/admin/reports", Some(&boss)).await.json();
    let r2 = by_id(&v, &rep2["id"]);
    assert_eq!(r2["status"], "resolved");
    assert_eq!(r2["resolution"], "delete");
    assert!(r2["targetImageUrl"].is_null());
    assert_eq!(by_id(&v, &game_rep["id"])["status"], "open");

    // A screenshot on an unpublished game can't be reported by others.
    let draft = game_id(&t, &ana, false).await;
    let s3 = sid(&post_ok(&t, &ana, &draft, None).await);
    assert_eq!(
        report(&t, &bob, "screenshot", &s3).await.status,
        StatusCode::NOT_FOUND
    );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn game_delete_removes_files_and_sweep_removes_orphans() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let gid = game_id(&t, &a, true).await;
    let s1 = sid(&post_ok(&t, &a, &gid, None).await);
    let s2 = sid(&post_ok(&t, &a, &gid, None).await);
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{gid}"),
            Some(&a),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(files_of(&t, &s1).is_empty());
    assert!(files_of(&t, &s2).is_empty());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM screenshots")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);

    let g2 = game_id(&t, &a, true).await;
    let keep = sid(&post_ok(&t, &a, &g2, None).await);
    for orphan in [
        "orphan.png",
        "orphan.jpg",
        "orphan_t.jpg",
        ".orphan.x.tmp",
        "junk.txt",
    ] {
        std::fs::write(stored(&t, orphan), b"x").unwrap();
    }
    let removed = sweep_stale_files(&t.state).await.unwrap();
    assert!(removed >= 5, "{removed}");
    let mut left: Vec<String> = std::fs::read_dir(t.state.storage.screenshots_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, vec![format!("{keep}.png"), format!("{keep}_t.jpg")]);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_rebuilds_reports_preserving_rows_and_indices() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    for sql in [
        include_str!("../migrations/0001_init.sql"),
        include_str!("../migrations/0002_v2.sql"),
        include_str!("../migrations/0003_f001.sql"),
        include_str!("../migrations/0004_perf_indices.sql"),
        include_str!("../migrations/0005_f002.sql"),
        include_str!("../migrations/0006_f003.sql"),
        include_str!("../migrations/0007_f004.sql"),
        include_str!("../migrations/0008_review2.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&db).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
         display_name, created_at) VALUES ('u1', 'Rep', 'rep', 'r@x', 'r@x', 'h', 'Rep', 'now')",
    )
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, reason, \
         details, reporter_id, status, resolution, created_at, resolved_at) VALUES \
         ('r1', 'game', 'g1', 'g1', 'A game', 'spam', 'd1', 'u1', 'open', NULL, 't1', NULL), \
         ('r2', 'comment', 'c1', 'g1', 'A comment', 'offensive', '', 'u1', 'resolved', 'delete', \
          't2', 't3')",
    )
    .execute(&db)
    .await
    .unwrap();

    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
    );
    let rows_sql = "SELECT id, target_type, target_id, target_game_id, target_preview, reason, \
                    details, reporter_id, status, resolution, created_at, resolved_at \
                    FROM reports ORDER BY rowid";
    let idx_sql = "SELECT name, sql FROM sqlite_master WHERE type = 'index' \
                   AND tbl_name = 'reports' AND sql IS NOT NULL ORDER BY name";
    let before: Vec<Row> = sqlx::query_as(rows_sql).fetch_all(&db).await.unwrap();
    let idx_before: Vec<(String, String)> = sqlx::query_as(idx_sql).fetch_all(&db).await.unwrap();
    assert_eq!(idx_before.len(), 3);

    sqlx::raw_sql(include_str!("../migrations/0009_f005.sql"))
        .execute(&db)
        .await
        .unwrap();

    let after: Vec<Row> = sqlx::query_as(rows_sql).fetch_all(&db).await.unwrap();
    assert_eq!(before, after);
    let idx_after: Vec<(String, String)> = sqlx::query_as(idx_sql).fetch_all(&db).await.unwrap();
    assert_eq!(idx_before, idx_after);
    // Triggers elsewhere survive (none were on reports).
    let triggers: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(triggers >= 5, "{triggers}");
    let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&db)
        .await
        .unwrap();
    assert!(fk.is_empty());

    // The widened CHECK accepts screenshots and still rejects anything else.
    let ins = |tt: &'static str, id: &'static str| {
        sqlx::query(
            "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, \
             reason, reporter_id, created_at) VALUES (?, ?, 's', 'g', 'p', 'spam', 'u1', 't')",
        )
        .bind(id)
        .bind(tt)
    };
    ins("screenshot", "r3").execute(&db).await.unwrap();
    assert!(ins("bogus", "r4").execute(&db).await.is_err());
    // The default status still applies.
    let st: String = sqlx::query_scalar("SELECT status FROM reports WHERE id = 'r3'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(st, "open");
}
