//! F012: bitmap fonts (docs/API.md § F012 additions). The backend only allows and serves `.fnt`;
//! it never parses the descriptor.

mod common;

use std::io::{Cursor, Read};

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::Value;

const MAIN_JS: &[u8] = b"export default { update() {}, render() {} };";
const FNT: &[u8] = b"info face=\"Pixel\" size=8 bold=0 italic=0 charset=\"\" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1\n\
common lineHeight=10 base=8 scaleW=64 scaleH=64 pages=1 packed=0\n\
page id=0 file=\"f_0.png\"\n\
chars count=1\n\
char id=65 x=0 y=0 width=6 height=8 xoffset=0 yoffset=0 xadvance=7 page=0 chnl=15\n";

fn fnt_bundle(fnt: &[u8]) -> Vec<u8> {
    let png = png_bytes();
    make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", MAIN_JS),
        ("assets/f.fnt", fnt),
        ("assets/f_0.png", &png),
    ])
}

async fn upload(t: &TestApp, tok: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::POST,
        "/api/games",
        Some(tok),
        &[
            Part::Text("title", "Fonts"),
            Part::Text("published", "true"),
            Part::File("bundle", "game.zip", "application/zip", zip),
        ],
    )
    .await
}

async fn replace(t: &TestApp, tok: &str, id: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(tok),
        &[Part::File("bundle", "game.zip", "application/zip", zip)],
    )
    .await
}

fn created_id(r: &Resp) -> String {
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v: Value = r.json();
    v["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn fnt_upload_and_serve() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let id = created_id(&upload(&t, &tok, &fnt_bundle(FNT)).await);

    let r = t
        .get(&format!("/games/{id}/files/assets/f.fnt"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.header("content-type"), "text/plain; charset=utf-8");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert!(
        r.header("content-security-policy").contains("sandbox"),
        "{}",
        r.header("content-security-policy")
    );
    assert_eq!(r.body, FNT);

    let png = t
        .get(&format!("/games/{id}/files/assets/f_0.png"), None)
        .await;
    assert_eq!(png.status, StatusCode::OK);
    assert_eq!(png.header("content-type"), "image/png");
}

#[tokio::test]
async fn fnt_extension_is_case_insensitive_and_unparsed() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    // Garbage (XML) content is accepted: the backend never parses `.fnt`.
    let xml = b"<?xml version=\"1.0\"?><font></font>";
    let zip = make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", MAIN_JS),
        ("assets/F.FNT", xml),
    ]);
    let id = created_id(&upload(&t, &tok, &zip).await);
    let r = t
        .get(&format!("/games/{id}/files/assets/F.FNT"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-type"), "text/plain; charset=utf-8");
    assert_eq!(r.body, xml);
}

#[tokio::test]
async fn bundle_replace_with_fnt() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let id = created_id(&upload(&t, &tok, &valid_bundle()).await);

    let r = replace(&t, &tok, &id, &fnt_bundle(FNT)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["version"], 2);

    let f = t
        .get(&format!("/games/{id}/files/assets/f.fnt"), None)
        .await;
    assert_eq!(f.status, StatusCode::OK);
    assert_eq!(f.body, FNT);
}

#[tokio::test]
async fn xml_is_still_rejected_and_message_lists_fnt() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let zip = make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", MAIN_JS),
        ("assets/f.xml", b"<font/>"),
    ]);
    let r = upload(&t, &tok, &zip).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(r.error_code(), "validation");
    let msg = r.json()["error"]["message"].as_str().unwrap().to_string();
    assert!(msg.contains("assets/f.xml"), "{msg}");
    assert!(msg.contains("ttf, fnt"), "{msg}");

    // Same allowlist on replace.
    let id = created_id(&upload(&t, &tok, &valid_bundle()).await);
    let r = replace(&t, &tok, &id, &zip).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(r.error_code(), "validation");
    assert!(r.text().contains("fnt"), "{}", r.text());
}

#[tokio::test]
async fn owner_export_round_trips_fnt() {
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let id = created_id(&upload(&t, &tok, &fnt_bundle(FNT)).await);

    let r = t.get(&format!("/api/games/{id}/bundle"), Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let mut a = zip::ZipArchive::new(Cursor::new(r.body.clone())).unwrap();
    let mut f = a.by_name("assets/f.fnt").expect("assets/f.fnt in export");
    assert_eq!(f.compression(), zip::CompressionMethod::Deflated);
    let mut data = Vec::new();
    f.read_to_end(&mut data).unwrap();
    assert_eq!(data, FNT);
    drop(f);

    // And the export re-uploads.
    let up = replace(&t, &tok, &id, &r.body).await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());
}

fn zip_has_fnt(bytes: &[u8]) -> bool {
    let Ok(mut a) = zip::ZipArchive::new(Cursor::new(bytes.to_vec())) else {
        return false;
    };
    (0..a.len()).any(|i| {
        a.by_index(i)
            .map(|f| f.name().to_ascii_lowercase().ends_with(".fnt"))
            .unwrap_or(false)
    })
}

#[tokio::test]
async fn packed_pixel_peaks_uploads() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/dist/pixel-peaks.zip");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!(
            "SKIP packed_pixel_peaks_uploads: {} not found (run `npm run examples`)",
            path.display()
        );
        return;
    };
    if !zip_has_fnt(&bytes) {
        eprintln!(
            "SKIP packed_pixel_peaks_uploads: {} has no .fnt yet (repack with `npm run examples`)",
            path.display()
        );
        return;
    }
    let t = setup().await;
    let (tok, _) = t.register("alice").await;
    let r = upload(&t, &tok, &bytes).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
}
