//! Review 11 backend fixes:
//! - L1: `displayName` and `bio` use the shared forbidden-character set (bio allows `\n`);
//! - L2: the set gains U+061C, U+115F, U+1160, U+180E, U+2028, U+2029, U+3164 and U+FFA0,
//!   and post bodies use it (so U+2028/U+2029 can't bypass the 12-line cap);
//! - L5: a banner upload can't interleave with `clearProfile`, a banner delete or a user
//!   delete and leave `bannerUrl` pointing at a missing file.

mod common;

use std::io::Cursor;
use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

const NAME_MSG: &str = "displayName must not contain control characters";
const BIO_MSG: &str = "bio must not contain control characters";
const POST_MSG: &str = "body must be plain text";

/// The characters added in review 11.
const NEW_CHARS: [char; 8] = [
    '\u{61C}', '\u{115F}', '\u{1160}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{3164}', '\u{FFA0}',
];

/// The F028 set, sampled at both ends of each range (and DEL).
const OLD_CHARS: [char; 14] = [
    '\u{1}', '\u{9}', '\u{1F}', '\u{7F}', '\u{85}', '\u{9F}', '\u{200B}', '\u{200F}', '\u{202A}',
    '\u{202E}', '\u{2060}', '\u{2064}', '\u{2066}', '\u{FEFF}',
];

fn all_chars() -> impl Iterator<Item = char> {
    NEW_CHARS.into_iter().chain(OLD_CHARS).chain(['\u{2069}'])
}

fn assert_422(r: &Resp, message: &str) {
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    let v = r.json();
    assert_eq!(v["error"]["code"], "validation", "{}", r.text());
    assert_eq!(v["error"]["message"], message, "{}", r.text());
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

// ---------------------------------------------------------------------------
// L1: displayName and bio
// ---------------------------------------------------------------------------

#[tokio::test]
async fn display_name_rejects_every_forbidden_character() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    for c in all_chars() {
        let r = patch_me(&t, &tok, json!({ "displayName": format!("Mi{c}a") })).await;
        assert_422(&r, NAME_MSG);
    }
    // The spoofing cases from the review: a trailing RLO, and a look-alike with ZWSP.
    for name in ["mia\u{202E}", "mia\u{200B}", "\u{3164}", "mia\u{2028}x"] {
        assert_422(
            &patch_me(&t, &tok, json!({ "displayName": name })).await,
            NAME_MSG,
        );
    }
    assert_eq!(me(&t, &tok).await["displayName"], "mia");

    // Ordinary Unicode and surrounding whitespace still work.
    let r = patch_me(&t, &tok, json!({ "displayName": "  Mía 李 ✨ " })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["displayName"], "Mía 李 ✨");
    // The length message is unchanged.
    assert_422(
        &patch_me(&t, &tok, json!({ "displayName": " " })).await,
        "displayName must be 1-50 characters",
    );
}

#[tokio::test]
async fn bio_rejects_every_forbidden_character_but_keeps_newlines() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    for c in all_chars() {
        let r = patch_me(&t, &tok, json!({ "bio": format!("hello{c}world") })).await;
        assert_422(&r, BIO_MSG);
    }
    // `\r` is a C0 control too; U+2028/U+2029 are not a way to add lines.
    for bio in ["a\r\nb", "a\rb", "a\u{2028}b", "a\u{2029}b"] {
        assert_422(&patch_me(&t, &tok, json!({ "bio": bio })).await, BIO_MSG);
    }
    assert_eq!(me(&t, &tok).await["bio"], "");

    let r = patch_me(
        &t,
        &tok,
        json!({ "bio": "  line one\nline two\n\nthree \n" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bio"], "line one\nline two\n\nthree");
    assert_422(
        &patch_me(&t, &tok, json!({ "bio": "b".repeat(1001) })).await,
        "bio must be at most 1000 characters",
    );
}

#[tokio::test]
async fn field_order_and_nothing_written_on_failure() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    // displayName is checked before bio, and bio before links.
    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": "a\u{202E}", "bio": "b\u{202E}", "links": [{ "url": "ftp://x" }] }),
    )
    .await;
    assert_422(&r, NAME_MSG);
    let r = patch_me(
        &t,
        &tok,
        json!({ "displayName": "Fine", "bio": "b\u{2029}c","links": [{ "url": "ftp://x" }] }),
    )
    .await;
    assert_422(&r, BIO_MSG);
    let v = me(&t, &tok).await;
    assert_eq!(v["displayName"], "mia");
    assert_eq!(v["bio"], "");
}

#[tokio::test]
async fn link_labels_use_the_extended_set() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    for c in NEW_CHARS {
        let r = patch_me(
            &t,
            &tok,
            json!({ "links": [{ "label": format!("a{c}b"), "url": "https://x.com" }] }),
        )
        .await;
        assert_422(&r, "links[0].label must not contain control characters");
    }
}

#[tokio::test]
async fn existing_stored_values_are_untouched() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;
    let name = "mia\u{202E}";
    let bio = "x\u{2028}y";
    sqlx::query("UPDATE users SET display_name = ?, bio = ? WHERE id = ?")
        .bind(name)
        .bind(bio)
        .bind(&uid)
        .execute(&t.state.db)
        .await
        .unwrap();
    // Reads return them as stored.
    let v = me(&t, &tok).await;
    assert_eq!(v["displayName"], name);
    assert_eq!(v["bio"], bio);
    // Only fields present in a PATCH are validated, so updating links keeps them.
    let r = patch_me(&t, &tok, json!({ "links": [] })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["displayName"], name);
    assert_eq!(r.json()["bio"], bio);
    // Writing them again is refused.
    assert_422(
        &patch_me(&t, &tok, json!({ "displayName": name })).await,
        NAME_MSG,
    );
    assert_422(&patch_me(&t, &tok, json!({ "bio": bio })).await, BIO_MSG);
}

// ---------------------------------------------------------------------------
// L2: post bodies
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_body_rejects_the_new_characters_and_separator_lines() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    let post = |body: String| {
        let t = &t;
        let tok = tok.clone();
        async move {
            t.json(
                Method::POST,
                "/api/posts",
                Some(&tok),
                json!({ "body": body }),
            )
            .await
        }
    };
    for c in all_chars() {
        assert_422(&post(format!("hello{c}world")).await, POST_MSG);
    }
    // The review's bypass: 30 lines joined with U+2028 (or U+2029).
    assert_422(&post(["line"; 30].join("\u{2028}")).await, POST_MSG);
    assert_422(&post(["line"; 30].join("\u{2029}")).await, POST_MSG);
    // `\n` stays allowed, and the line cap still applies to it.
    let r = post(["line"; 12].join("\n")).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_422(
        &post(["line"; 13].join("\n")).await,
        "body must be at most 12 lines",
    );
}

// ---------------------------------------------------------------------------
// L5: banner upload vs clearProfile / delete banner / user delete
// ---------------------------------------------------------------------------

fn banner_png() -> Vec<u8> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(600, 200, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

async fn put_banner(t: &TestApp, tok: &str) -> Resp {
    t.multipart(
        Method::PUT,
        "/api/users/me/banner",
        Some(tok),
        &[Part::File("banner", "b.png", "image/png", &banner_png())],
    )
    .await
}

fn banner_file(t: &TestApp, uid: &str) -> std::path::PathBuf {
    t.state.storage.banners_dir().join(format!("{uid}.jpg"))
}

async fn banner_row(t: &TestApp, uid: &str) -> (Option<String>, i64) {
    sqlx::query_as("SELECT banner_ext, banner_version FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

/// Run `other` while a banner upload is paused between its file write and its row update.
/// `other` must not finish until the upload goes on. Returns both responses.
async fn race_with_upload<F, Fut>(t: &TestApp, tok: &str, uid: &str, other: F) -> (Resp, Resp)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Resp>,
{
    let gate = t.state.profile_locks.install_gate();
    tokio::join!(put_banner(t, tok), async {
        gate.entered().await;
        // The upload has written its file and holds the user's lock.
        assert!(banner_file(t, uid).exists());
        let mut fut = std::pin::pin!(other());
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut fut)
                .await
                .is_err(),
            "the competing operation must wait for the upload"
        );
        gate.release();
        fut.await
    })
}

#[tokio::test]
async fn clear_profile_during_banner_upload_leaves_no_dangling_url() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let (admin, _) = t.register("boss").await;
    let (tok, uid) = t.register("uma").await;
    let (p_tok, _) = t.register("pat").await;
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(&p_tok),
            json!({ "targetType": "user", "targetId": uid, "reason": "offensive" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rid = r.json()["id"].as_str().unwrap().to_string();

    let resolve_uri = format!("/api/admin/reports/{rid}/resolve");
    let (up, cleared) = race_with_upload(&t, &tok, &uid, || {
        t.json(
            Method::POST,
            &resolve_uri,
            Some(&admin),
            json!({ "action": "clearProfile" }),
        )
    })
    .await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text());

    // The clear ran after the upload: no banner, and no file.
    assert_eq!(me(&t, &tok).await["bannerUrl"], Value::Null);
    assert!(!banner_file(&t, &uid).exists());
    assert_eq!(banner_row(&t, &uid).await, (None, 2));

    // A later upload works normally.
    let r = put_banner(&t, &tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json()["bannerUrl"],
        format!("/media/banners/{uid}.jpg?v=3")
    );
    assert!(banner_file(&t, &uid).exists());
}

#[tokio::test]
async fn delete_banner_during_upload_leaves_no_dangling_url() {
    let t = setup().await;
    let (tok, uid) = t.register("uma").await;
    let (up, del) = race_with_upload(&t, &tok, &uid, || {
        t.send(
            Method::DELETE,
            "/api/users/me/banner",
            Some(&tok),
            None,
            vec![],
            &[],
        )
    })
    .await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());
    assert_eq!(del.status, StatusCode::OK, "{}", del.text());
    assert_eq!(del.json()["bannerUrl"], Value::Null);
    assert!(!banner_file(&t, &uid).exists());
    assert_eq!(banner_row(&t, &uid).await, (None, 2));
}

#[tokio::test]
async fn user_deleted_during_banner_upload_leaves_no_file() {
    let t = setup().await;
    let (tok, uid) = t.register("uma").await;
    let gate = t.state.profile_locks.install_gate();
    let (up, ()) = tokio::join!(put_banner(&t, &tok), async {
        gate.entered().await;
        assert!(banner_file(&t, &uid).exists());
        sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(&uid)
            .execute(&t.state.db)
            .await
            .unwrap();
        gate.release();
    });
    // The row is gone, so the upload removes its own file and reports the missing user.
    assert_eq!(up.status, StatusCode::NOT_FOUND, "{}", up.text());
    assert!(!banner_file(&t, &uid).exists());
}
