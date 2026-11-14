//! F013: `GET /api/games/{id}/bundle` (owner-only bundle download).

mod common;

use std::io::{Cursor, Read};

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::Value;

const MAIN_JS: &[u8] = b"export default { update() { /* move */ }, render() {} };";
const DATA_JSON: &[u8] = br#"{ "levels": [1, 2, 3] }"#;

fn png() -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend((0..=255u8).cycle().take(2048));
    v
}

/// A bundle whose files sit inside one top-level folder, with nested assets and a binary PNG.
fn nested_bundle() -> Vec<u8> {
    let png = png();
    make_zip(&[
        ("space-dodge/game.json", GAME_JSON.as_bytes()),
        ("space-dodge/main.js", MAIN_JS),
        ("space-dodge/assets/data.json", DATA_JSON),
        ("space-dodge/assets/sprites/player.png", &png),
    ])
}

struct Entry {
    name: String,
    method: zip::CompressionMethod,
    data: Vec<u8>,
}

fn entries(bytes: &[u8]) -> Vec<Entry> {
    let mut a = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
    (0..a.len())
        .map(|i| {
            let mut f = a.by_index(i).unwrap();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            Entry {
                name: f.name().to_string(),
                method: f.compression(),
                data,
            }
        })
        .collect()
}

fn names(bytes: &[u8]) -> Vec<String> {
    entries(bytes).into_iter().map(|e| e.name).collect()
}

async fn create_from(t: &TestApp, token: &str, title: &str, zip: &[u8], published: bool) -> Value {
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(token),
            &[
                Part::Text("title", title),
                Part::Text("published", if published { "true" } else { "false" }),
                Part::File("bundle", "game.zip", "application/zip", zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn replace(t: &TestApp, token: &str, id: &str, zip: &[u8], expected: &str) -> Resp {
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(token),
        &[
            Part::Text("expectedVersion", expected),
            Part::File("bundle", "game.zip", "application/zip", zip),
        ],
    )
    .await
}

async fn download(t: &TestApp, id: &str, token: Option<&str>) -> Resp {
    t.get(&format!("/api/games/{id}/bundle"), token).await
}

fn is_slug_filename(disposition: &str, version: i64) -> bool {
    let Some(name) = disposition
        .strip_prefix("attachment; filename=\"")
        .and_then(|s| s.strip_suffix('"'))
    else {
        return false;
    };
    let Some(slug) = name.strip_suffix(&format!("-v{version}.zip")) else {
        return false;
    };
    !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[tokio::test]
async fn round_trip_and_reupload() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let g = create_from(&t, &tok, "Space Dodge!", &nested_bundle(), true).await;
    let id = g["id"].as_str().unwrap();

    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.header("content-type"), "application/zip");
    assert_eq!(r.header("x-game-version"), "1");
    assert_eq!(r.header("cache-control"), "no-store");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("content-length"), r.body.len().to_string());
    let cd = r.header("content-disposition");
    assert!(is_slug_filename(&cd, 1), "{cd}");
    assert_eq!(cd, "attachment; filename=\"space-dodge-v1.zip\"");

    let e = entries(&r.body);
    let got: Vec<&str> = e.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        got,
        [
            "game.json",
            "assets/data.json",
            "assets/sprites/player.png",
            "main.js"
        ]
    );
    assert_eq!(e[0].data, GAME_JSON.as_bytes());
    assert_eq!(e[1].data, DATA_JSON);
    assert_eq!(e[2].data, png());
    assert_eq!(e[3].data, MAIN_JS);
    assert_eq!(e[2].method, zip::CompressionMethod::Stored);
    assert_eq!(e[3].method, zip::CompressionMethod::Deflated);
    assert_eq!(e[1].method, zip::CompressionMethod::Deflated);

    // The downloaded archive re-uploads unchanged.
    let first = r.body.clone();
    let up = replace(&t, &tok, id, &first, "1").await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());
    assert_eq!(up.json()["version"], 2);

    let r2 = download(&t, id, Some(&tok)).await;
    assert_eq!(r2.status, StatusCode::OK);
    assert_eq!(r2.header("x-game-version"), "2");
    assert_eq!(
        r2.header("content-disposition"),
        "attachment; filename=\"space-dodge-v2.zip\""
    );
    let e2 = entries(&r2.body);
    assert_eq!(names(&r2.body), names(&first));
    for (a, b) in e.iter().zip(e2.iter()) {
        assert_eq!(a.data, b.data, "{}", a.name);
    }
}

#[tokio::test]
async fn download_has_only_the_current_versions_files() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let g = create_from(&t, &tok, "Space Dodge", &nested_bundle(), true).await;
    let id = g["id"].as_str().unwrap();

    let v2 = make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", b"export default {};"),
        ("lib/other.js", b"export const x = 1;"),
    ]);
    let up = replace(&t, &tok, id, &v2, "1").await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());

    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("x-game-version"), "2");
    assert_eq!(names(&r.body), ["game.json", "lib/other.js", "main.js"]);
}

#[tokio::test]
async fn unpublished_game_downloads_for_its_owner() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let g = t.create_game(&tok, "Draft Game", "", false).await;
    let id = g["id"].as_str().unwrap();
    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.header("x-game-version"), "1");
    assert!(is_slug_filename(&r.header("content-disposition"), 1));
    assert_eq!(names(&r.body)[0], "game.json");
}

#[tokio::test]
async fn access_rules() {
    let t = setup().await;
    let (alice, _) = t.register("alice").await;
    let (bob, _) = t.register("bob").await;
    let published = t.create_game(&alice, "Public", "", true).await;
    let draft = t.create_game(&alice, "Draft", "", false).await;

    for g in [&published, &draft] {
        let id = g["id"].as_str().unwrap();
        // Anonymous.
        let r = download(&t, id, None).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_eq!(r.error_code(), "unauthorized");

        // A preview-scoped token is not a session.
        let p = t
            .json(
                Method::POST,
                &format!("/api/games/{id}/preview-token"),
                Some(&alice),
                serde_json::json!({}),
            )
            .await;
        assert_eq!(p.status, StatusCode::OK, "{}", p.text());
        let preview = p.json()["token"].as_str().unwrap().to_string();
        let r = download(&t, id, Some(&preview)).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);

        // Another user gets the same answer as for `PUT …/bundle`.
        let r = download(&t, id, Some(&bob)).await;
        let put = replace(&t, &bob, id, &valid_bundle(), "1").await;
        assert_eq!(r.status, put.status);
        assert_eq!(r.error_code(), put.error_code());
        assert!(
            r.status == StatusCode::FORBIDDEN || r.status == StatusCode::NOT_FOUND,
            "{}",
            r.status
        );
    }
    let pid = published["id"].as_str().unwrap();
    assert_eq!(
        download(&t, pid, Some(&bob)).await.status,
        StatusCode::FORBIDDEN
    );
    let did = draft["id"].as_str().unwrap();
    assert_eq!(
        download(&t, did, Some(&bob)).await.status,
        StatusCode::NOT_FOUND
    );

    let r = download(&t, "no-such-game", Some(&alice)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
}

#[tokio::test]
async fn download_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("alice").await;
    let g = t.create_game(&tok, "Space Dodge", "", true).await;
    let id = g["id"].as_str().unwrap();
    for i in 0..30 {
        let r = download(&t, id, Some(&tok)).await;
        assert_eq!(r.status, StatusCode::OK, "download {i}: {}", r.text());
    }
    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    let wait: u64 = r.header("retry-after").parse().unwrap();
    assert!(wait >= 1);
}

#[tokio::test]
async fn busy_server_returns_503() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let g = t.create_game(&tok, "Space Dodge", "", true).await;
    let id = g["id"].as_str().unwrap();

    let held = t
        .state
        .export_slots
        .clone()
        .try_acquire_many_owned(webgame_server::EXPORT_SLOTS as u32)
        .unwrap();
    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.error_code(), "unavailable");
    assert_eq!(r.header("retry-after"), "5");

    drop(held);
    let r = download(&t, id, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK);
    // The build released its permit.
    assert_eq!(
        t.state.export_slots.available_permits(),
        webgame_server::EXPORT_SLOTS
    );
}

#[tokio::test]
async fn cors_exposes_download_headers() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let g = t.create_game(&tok, "Space Dodge", "", true).await;
    let id = g["id"].as_str().unwrap();
    let uri = format!("/api/games/{id}/bundle");
    let origin = "http://localhost:5173";

    let pre = t
        .send(
            Method::OPTIONS,
            &uri,
            None,
            None,
            vec![],
            &[
                ("origin", origin),
                ("access-control-request-method", "GET"),
                ("access-control-request-headers", "authorization"),
            ],
        )
        .await;
    assert!(pre.status.is_success(), "{}", pre.status);
    assert_eq!(pre.header("access-control-allow-origin"), origin);
    assert!(pre.header("access-control-allow-methods").contains("GET"));

    let r = t
        .send(
            Method::GET,
            &uri,
            Some(&tok),
            None,
            vec![],
            &[("origin", origin)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("access-control-allow-origin"), origin);
    let exposed = r
        .header("access-control-expose-headers")
        .to_ascii_lowercase();
    for h in ["x-game-version", "content-disposition", "retry-after"] {
        assert!(exposed.contains(h), "{exposed}");
    }
}
