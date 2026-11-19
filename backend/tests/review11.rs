//! Review 11 backend fixes:
//! - L1: `displayName` and `bio` use the shared forbidden-character set (bio allows `\n`);
//! - L2: the set gains U+061C, U+115F, U+1160, U+180E, U+2028, U+2029, U+3164 and U+FFA0,
//!   and post bodies use it (so U+2028/U+2029 can't bypass the 12-line cap).
//!
//! The L5 banner-race tests live in tests/f031.rs, which uses `profile_image_locks`.

mod common;

use axum::http::{Method, StatusCode};
use common::*;
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
    // U+2028/U+2029 are not a way to add lines.
    for bio in ["a\u{2028}b", "a\u{2029}b"] {
        assert_422(&patch_me(&t, &tok, json!({ "bio": bio })).await, BIO_MSG);
    }
    assert_eq!(me(&t, &tok).await["bio"], "");
    // `\r\n` and `\r` are normalised to `\n` (API § review 11), not rejected.
    let r = patch_me(&t, &tok, json!({ "bio": "a\r\nb\rc" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bio"], "a\nb\nc");

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
