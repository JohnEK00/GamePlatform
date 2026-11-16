//! F008: collections. CRUD, text rules, visibility, permissions, items and unavailable
//! placeholders, reorder and 409, caps and concurrency, lists and covers, reports on
//! collections, the 0016 `reports` rebuild (upgrade from a seeded 0015 database), the
//! `Collections` rate limit (ManualClock) and the demo seed collection.

mod common;

use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::*;
use serde_json::{Value, json};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
}

fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_string()
}

async fn game(t: &TestApp, tok: &str, title: &str, published: bool) -> String {
    s(&t.create_game(tok, title, "", published).await["id"])
}

/// Insert games directly (fast; no bundle files), returning their ids.
async fn insert_games(t: &TestApp, owner: &str, n: usize, prefix: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for i in 0..n {
        let id = format!("{prefix}-{i:03}");
        sqlx::query(
            "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, \
             updated_at, actions_json, controls_hint) \
             VALUES (?, ?, ?, 'main.js', 800, 600, '2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z', '[]', '')",
        )
        .bind(&id)
        .bind(owner)
        .bind(format!("Game {id}"))
        .execute(&t.state.db)
        .await
        .unwrap();
        ids.push(id);
    }
    ids
}

async fn set_thumb(t: &TestApp, gid: &str) {
    sqlx::query("UPDATE games SET thumbnail_ext = 'png', thumbnail_version = 1 WHERE id = ?")
        .bind(gid)
        .execute(&t.state.db)
        .await
        .unwrap();
}

fn thumb(gid: &str) -> String {
    format!("/media/thumbnails/{gid}.png?v=1")
}

async fn set_published(t: &TestApp, tok: &str, gid: &str, published: bool) {
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{gid}"),
            Some(tok),
            json!({ "published": published }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn create(t: &TestApp, tok: Option<&str>, body: Value) -> Resp {
    t.json(Method::POST, "/api/collections", tok, body).await
}

/// Create a collection; returns its id.
async fn mk(t: &TestApp, tok: &str, title: &str, visibility: &str) -> String {
    let r = create(
        t,
        Some(tok),
        json!({ "title": title, "visibility": visibility }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    s(&r.json()["id"])
}

async fn get_c(t: &TestApp, tok: Option<&str>, cid: &str) -> Resp {
    t.get(&format!("/api/collections/{cid}"), tok).await
}

async fn patch(t: &TestApp, tok: Option<&str>, cid: &str, body: Value) -> Resp {
    t.json(Method::PATCH, &format!("/api/collections/{cid}"), tok, body)
        .await
}

async fn del(t: &TestApp, tok: Option<&str>, cid: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/collections/{cid}"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

/// `PUT …/games/{gid}`; `body: None` sends no body at all.
async fn put_item(
    t: &TestApp,
    tok: Option<&str>,
    cid: &str,
    gid: &str,
    body: Option<Value>,
) -> Resp {
    let uri = format!("/api/collections/{cid}/games/{gid}");
    match body {
        Some(b) => t.json(Method::PUT, &uri, tok, b).await,
        None => t.send(Method::PUT, &uri, tok, None, vec![], &[]).await,
    }
}

async fn add(t: &TestApp, tok: &str, cid: &str, gid: &str) -> Value {
    let r = put_item(t, Some(tok), cid, gid, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn remove(t: &TestApp, tok: Option<&str>, cid: &str, gid: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/collections/{cid}/games/{gid}"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn reorder(t: &TestApp, tok: Option<&str>, cid: &str, body: Value) -> Resp {
    t.json(
        Method::PUT,
        &format!("/api/collections/{cid}/order"),
        tok,
        body,
    )
    .await
}

fn item_ids(c: &Value) -> Vec<String> {
    c["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| s(&i["gameId"]))
        .collect()
}

fn list_ids(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| s(&i["id"]))
        .collect()
}

fn assert_err(r: &Resp, status: StatusCode, code: &str, msg: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    assert_eq!(r.error_code(), code, "{}", r.text());
    assert_eq!(r.json()["error"]["message"], msg, "{}", r.text());
}

fn assert_404(r: &Resp) {
    assert_err(
        r,
        StatusCode::NOT_FOUND,
        "not_found",
        "Collection not found",
    );
}

async fn count(t: &TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn positions(t: &TestApp, cid: &str) -> Vec<(String, i64)> {
    sqlx::query_as(
        "SELECT game_id, position FROM collection_games WHERE collection_id = ? \
         ORDER BY position, added_at, game_id",
    )
    .bind(cid)
    .fetch_all(&t.state.db)
    .await
    .unwrap()
}

async fn tick() {
    tokio::time::sleep(Duration::from_millis(3)).await;
}

async fn report(t: &TestApp, tok: &str, ty: &str, target: &str) -> Resp {
    t.json(
        Method::POST,
        "/api/reports",
        Some(tok),
        json!({ "targetType": ty, "targetId": target, "reason": "offensive" }),
    )
    .await
}

async fn resolve(t: &TestApp, tok: &str, rid: &str, action: &str) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/admin/reports/{rid}/resolve"),
        Some(tok),
        json!({ "action": action }),
    )
    .await
}

async fn report_state(t: &TestApp, rid: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT status, resolution FROM reports WHERE id = ?")
        .bind(rid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_defaults_and_shape() {
    let t = setup().await;
    let (tok, uid) = t.register("owen").await;
    let r = create(&t, Some(&tok), json!({ "title": "  Cozy games  " })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let c = r.json();
    let id = s(&c["id"]);
    assert_eq!(id.len(), 36);
    assert_eq!(c["title"], "Cozy games");
    assert_eq!(c["description"], "");
    assert_eq!(c["visibility"], "public");
    assert_eq!(c["owner"]["id"], uid.as_str());
    assert_eq!(c["owner"]["username"], "owen");
    assert_eq!(c["gameCount"], 0);
    assert_eq!(c["coverUrls"], json!([]));
    assert_eq!(c["items"], json!([]));
    assert_eq!(c["path"], format!("/c/{id}"));
    assert_eq!(c["isOwner"], true);
    assert_eq!(c["canDelete"], true);
    assert_eq!(c["createdAt"], c["updatedAt"]);
    assert!(s(&c["createdAt"]).ends_with('Z'));

    // Unauthenticated → 401.
    let r = create(&t, None, json!({ "title": "x" })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_with_game_and_unknown_game() {
    let t = setup().await;
    let (tok, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &tok, "Space Dodge", true).await;
    let r = create(
        &t,
        Some(&tok),
        json!({ "title": "Mine", "visibility": "private", "gameId": gid, "description": "d" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let c = r.json();
    assert_eq!(c["visibility"], "private");
    assert_eq!(c["description"], "d");
    assert_eq!(c["gameCount"], 1);
    assert_eq!(c["items"][0]["gameId"], gid.as_str());
    assert_eq!(c["items"][0]["game"]["id"], gid.as_str());
    assert_eq!(c["items"][0]["note"], "");
    assert_eq!(positions(&t, &s(&c["id"])).await, vec![(gid.clone(), 0)]);

    // Unknown or invisible game → 404 and nothing is created.
    let hidden = game(&t, &mia, "Hidden", false).await;
    for g in ["nope", hidden.as_str()] {
        let r = create(&t, Some(&tok), json!({ "title": "X", "gameId": g })).await;
        assert_err(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");
    }
    assert_eq!(
        count(&t, "SELECT COUNT(*) FROM collections WHERE title = ?", "X").await,
        0
    );
    // gameId of the wrong type → 422.
    let r = create(&t, Some(&tok), json!({ "title": "X", "gameId": 5 })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn get_patch_delete() {
    let t = setup().await;
    let (tok, _) = t.register("owen").await;
    let gid = game(&t, &tok, "Space Dodge", true).await;
    let cid = mk(&t, &tok, "First", "public").await;
    add(&t, &tok, &cid, &gid).await;

    let c = get_c(&t, None, &cid).await.json();
    assert_eq!(c["title"], "First");
    assert_eq!(c["gameCount"], 1);
    let before = s(&c["updatedAt"]);

    // Empty object: no change, updatedAt not bumped.
    tick().await;
    let r = patch(&t, Some(&tok), &cid, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["updatedAt"], before.as_str());

    let r = patch(&t, Some(&tok), &cid, json!({ "title": "Second" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["title"], "Second");
    assert_ne!(v["updatedAt"], before.as_str());
    assert_eq!(v["items"][0]["gameId"], gid.as_str());

    let r = patch(
        &t,
        Some(&tok),
        &cid,
        json!({ "description": "Line 1\r\nLine 2" }),
    )
    .await;
    assert_eq!(r.json()["description"], "Line 1\nLine 2");
    let r = patch(&t, Some(&tok), &cid, json!({ "visibility": "private" })).await;
    let v = r.json();
    assert_eq!(v["visibility"], "private");
    assert_eq!(v["title"], "Second");
    assert_eq!(v["description"], "Line 1\nLine 2");
    let r = patch(&t, Some(&tok), &cid, json!({ "description": "" })).await;
    assert_eq!(r.json()["description"], "");

    let r = del(&t, Some(&tok), &cid).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_404(&get_c(&t, Some(&tok), &cid).await);
    assert_404(&del(&t, Some(&tok), &cid).await);
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM collection_games WHERE collection_id = ?",
            &cid
        )
        .await,
        0
    );
    // The game is unaffected.
    assert_eq!(
        t.get(&format!("/api/games/{gid}"), None).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn is_owner_and_can_delete_per_viewer() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (boss, _) = t.register("boss").await;
    let (mia, _) = t.register("mia").await;
    let cid = mk(&t, &owner, "Public", "public").await;
    for (tok, is_owner, can_delete) in [
        (Some(owner.as_str()), true, true),
        (Some(boss.as_str()), false, true),
        (Some(mia.as_str()), false, false),
        (None, false, false),
    ] {
        let v = get_c(&t, tok, &cid).await.json();
        assert_eq!(v["isOwner"], is_owner);
        assert_eq!(v["canDelete"], can_delete);
    }
}

// ---------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------

#[tokio::test]
async fn text_rules() {
    let t = setup().await;
    let (tok, _) = t.register("owen").await;
    let gid = game(&t, &tok, "Space Dodge", true).await;
    let v422 =
        |r: &Resp, msg: &str| assert_err(r, StatusCode::UNPROCESSABLE_ENTITY, "validation", msg);

    let title_len = "title must be 1–60 characters";
    let title_line = "title must be a single line of plain text";
    for (title, msg) in [
        (json!(""), title_len),
        (json!("   "), title_len),
        (json!("a".repeat(61)), title_len),
        (json!("a\nb"), title_line),
        (json!("a\u{202E}b"), title_line),
        (json!("a\u{2066}b"), title_line),
    ] {
        v422(
            &create(&t, Some(&tok), json!({ "title": title })).await,
            msg,
        );
    }
    v422(&create(&t, Some(&tok), json!({})).await, title_len);
    assert_eq!(
        create(&t, Some(&tok), json!({ "title": 5 })).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // 60 scalar values (multi-byte) are fine.
    let r = create(&t, Some(&tok), json!({ "title": "é".repeat(60) })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());

    for (desc, msg) in [
        (
            "a".repeat(501),
            "description must be at most 500 characters",
        ),
        (["l"; 9].join("\n"), "description must be at most 8 lines"),
        ("a\tb".to_string(), "description must be plain text"),
        ("a\u{202A}b".to_string(), "description must be plain text"),
    ] {
        v422(
            &create(&t, Some(&tok), json!({ "title": "T", "description": desc })).await,
            msg,
        );
    }
    let r = create(
        &t,
        Some(&tok),
        json!({ "title": "T", "description": format!("  {}  ", ["l"; 8].join("\r\n")) }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(r.json()["description"], ["l"; 8].join("\n"));
    let r = create(
        &t,
        Some(&tok),
        json!({ "title": "T", "description": "a\rb" }),
    )
    .await;
    assert_eq!(r.json()["description"], "a\nb");

    for vis in [json!("unlisted"), json!("Public"), json!(1)] {
        v422(
            &create(&t, Some(&tok), json!({ "title": "T", "visibility": vis })).await,
            "visibility must be \"public\" or \"private\"",
        );
    }

    // Notes.
    let cid = mk(&t, &tok, "Notes", "public").await;
    v422(
        &put_item(
            &t,
            Some(&tok),
            &cid,
            &gid,
            Some(json!({ "note": "n".repeat(141) })),
        )
        .await,
        "note must be at most 140 characters",
    );
    v422(
        &put_item(&t, Some(&tok), &cid, &gid, Some(json!({ "note": "a\nb" }))).await,
        "note must be a single line of plain text",
    );
    v422(
        &put_item(
            &t,
            Some(&tok),
            &cid,
            &gid,
            Some(json!({ "note": "a\u{202E}b" })),
        )
        .await,
        "note must be a single line of plain text",
    );
    assert_eq!(
        put_item(&t, Some(&tok), &cid, &gid, Some(json!({ "note": 3 })))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let r = put_item(
        &t,
        Some(&tok),
        &cid,
        &gid,
        Some(json!({ "note": format!(" {} ", "n".repeat(140)) })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["item"]["note"], "n".repeat(140));

    // PATCH applies the same rules; malformed JSON → 400; a non-object → 422.
    v422(
        &patch(&t, Some(&tok), &cid, json!({ "title": "" })).await,
        title_len,
    );
    v422(
        &patch(&t, Some(&tok), &cid, json!({ "visibility": "unlisted" })).await,
        "visibility must be \"public\" or \"private\"",
    );
    let r = t
        .send(
            Method::PATCH,
            &format!("/api/collections/{cid}"),
            Some(&tok),
            Some("application/json"),
            b"{nope".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        patch(&t, Some(&tok), &cid, json!([1])).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let r = t
        .send(
            Method::POST,
            "/api/collections",
            Some(&tok),
            Some("application/json"),
            b"not json".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Visibility and permissions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn private_collections_are_404_for_others() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (boss, _) = t.register("boss").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let cid = mk(&t, &owner, "Secret", "private").await;
    add(&t, &owner, &cid, &gid).await;

    for tok in [Some(mia.as_str()), None] {
        assert_404(&get_c(&t, tok, &cid).await);
    }
    // Writes: stranger → 404 at step 2 (never 403); anonymous → 401 first.
    assert_404(&patch(&t, Some(&mia), &cid, json!({ "title": "x" })).await);
    assert_404(&put_item(&t, Some(&mia), &cid, &gid, None).await);
    assert_404(&remove(&t, Some(&mia), &cid, &gid).await);
    assert_404(&reorder(&t, Some(&mia), &cid, json!({ "gameIds": [gid] })).await);
    assert_404(&del(&t, Some(&mia), &cid).await);
    assert_eq!(
        patch(&t, None, &cid, json!({ "title": "x" })).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_item(&t, None, &cid, &gid, None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        reorder(&t, None, &cid, json!({ "gameIds": [] }))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    // Reports by a stranger → 404.
    assert_404(&report(&t, &mia, "collection", &cid).await);

    // Owner and admin see it.
    let v = get_c(&t, Some(&owner), &cid).await.json();
    assert_eq!(v["gameCount"], 1);
    let v = get_c(&t, Some(&boss), &cid).await.json();
    assert_eq!(v["isOwner"], false);
    assert_eq!(v["canDelete"], true);
    assert_eq!(v["items"][0]["gameId"], gid.as_str());

    // Never listed for others, never on the game shelf (not even for the owner).
    let v = t
        .get("/api/users/owen/collections", Some(&mia))
        .await
        .json();
    assert_eq!(v["total"], 0);
    let v = t.get("/api/users/owen/collections", None).await.json();
    assert_eq!(v["total"], 0);
    let v = t
        .get("/api/users/owen/collections", Some(&owner))
        .await
        .json();
    assert_eq!(list_ids(&v["items"]), vec![cid.clone()]);
    assert_eq!(v["items"][0]["visibility"], "private");
    for tok in [Some(owner.as_str()), Some(mia.as_str()), None] {
        let v = t
            .get(&format!("/api/games/{gid}/collections"), tok)
            .await
            .json();
        assert_eq!(v["total"], 0);
        assert_eq!(v["items"], json!([]));
    }
}

#[tokio::test]
async fn empty_public_collections_listed_for_owner_only() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let cid = mk(&t, &owner, "Empty", "public").await;
    let v = t
        .get("/api/users/owen/collections", Some(&owner))
        .await
        .json();
    assert_eq!(list_ids(&v["items"]), vec![cid.clone()]);
    assert_eq!(v["items"][0]["gameCount"], 0);
    for tok in [Some(mia.as_str()), None] {
        let v = t.get("/api/users/owen/collections", tok).await.json();
        assert_eq!(v["total"], 0);
    }
    // Only an owner-only (unpublished) game inside → still hidden from others.
    let hidden = game(&t, &owner, "Draft", false).await;
    add(&t, &owner, &cid, &hidden).await;
    let v = t
        .get("/api/users/owen/collections", Some(&mia))
        .await
        .json();
    assert_eq!(v["total"], 0);
    // The collection itself is public: a stranger can open it, with no items.
    let v = get_c(&t, Some(&mia), &cid).await.json();
    assert_eq!(v["items"], json!([]));
    assert_eq!(v["gameCount"], 0);
}

#[tokio::test]
async fn permissions_on_public_collections() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (boss, _) = t.register("boss").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let cid = mk(&t, &owner, "Public", "public").await;
    add(&t, &owner, &cid, &gid).await;

    for tok in [&mia, &boss] {
        let forbidden = |r: Resp| assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.text());
        forbidden(patch(&t, Some(tok), &cid, json!({ "title": "x" })).await);
        forbidden(put_item(&t, Some(tok), &cid, &gid, Some(json!({ "note": "x" }))).await);
        forbidden(remove(&t, Some(tok), &cid, &gid).await);
        forbidden(reorder(&t, Some(tok), &cid, json!({ "gameIds": [gid] })).await);
    }
    // 403 comes before body validation.
    let r = patch(&t, Some(&mia), &cid, json!({ "title": "" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = del(&t, Some(&mia), &cid).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(get_c(&t, None, &cid).await.json()["title"], "Public");
    // Admin can delete.
    let r = del(&t, Some(&boss), &cid).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_404(&get_c(&t, Some(&owner), &cid).await);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

#[tokio::test]
async fn add_update_note_and_remove() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let g1 = game(&t, &owner, "One", true).await;
    let g2 = game(&t, &mia, "Two", true).await;
    let g3 = game(&t, &owner, "Three", true).await;
    let cid = mk(&t, &owner, "List", "public").await;

    let r = add(&t, &owner, &cid, &g1).await;
    assert_eq!(r["added"], true);
    assert_eq!(r["item"]["gameId"], g1.as_str());
    assert_eq!(r["item"]["game"]["title"], "One");
    assert_eq!(r["item"]["note"], "");
    assert_eq!(r["gameCount"], 1);
    let r = put_item(
        &t,
        Some(&owner),
        &cid,
        &g2,
        Some(json!({ "note": "Best soundtrack" })),
    )
    .await;
    let v = r.json();
    assert_eq!(v["added"], true);
    assert_eq!(v["item"]["note"], "Best soundtrack");
    assert_eq!(v["gameCount"], 2);
    let v = add(&t, &owner, &cid, &g3).await;
    assert_eq!(v["gameCount"], 3);
    assert_eq!(
        positions(&t, &cid).await,
        vec![(g1.clone(), 0), (g2.clone(), 1), (g3.clone(), 2)]
    );
    let c = get_c(&t, None, &cid).await.json();
    assert_eq!(item_ids(&c), vec![g1.clone(), g2.clone(), g3.clone()]);
    assert_eq!(c["updatedAt"], v["updatedAt"]);

    // Re-PUT with a note: note only, `added: false`, position kept.
    tick().await;
    let r = put_item(
        &t,
        Some(&owner),
        &cid,
        &g1,
        Some(json!({ "note": "Start here" })),
    )
    .await;
    let v = r.json();
    assert_eq!(v["added"], false);
    assert_eq!(v["item"]["note"], "Start here");
    assert_eq!(v["gameCount"], 3);
    assert_ne!(v["updatedAt"], c["updatedAt"]);
    let bumped = v["updatedAt"].clone();
    // Re-PUT without a note (no body, `{}`, `null` note) keeps it and doesn't bump.
    tick().await;
    for body in [None, Some(json!({})), Some(json!({ "note": null }))] {
        let v = put_item(&t, Some(&owner), &cid, &g1, body).await.json();
        assert_eq!(v["added"], false);
        assert_eq!(v["item"]["note"], "Start here");
        assert_eq!(v["updatedAt"], bumped);
    }
    assert_eq!(positions(&t, &cid).await[0], (g1.clone(), 0));

    // Remove: removed true, then false (no bump).
    tick().await;
    let r = remove(&t, Some(&owner), &cid, &g2).await;
    let v = r.json();
    assert_eq!(v["removed"], true);
    assert_eq!(v["gameCount"], 2);
    let after = v["updatedAt"].clone();
    assert_ne!(after, bumped);
    tick().await;
    let v = remove(&t, Some(&owner), &cid, &g2).await.json();
    assert_eq!(v["removed"], false);
    assert_eq!(v["gameCount"], 2);
    assert_eq!(v["updatedAt"], after);
    // Re-adding appends at the end (positions need only be ordered).
    add(&t, &owner, &cid, &g2).await;
    let c = get_c(&t, None, &cid).await.json();
    assert_eq!(item_ids(&c), vec![g1.clone(), g3.clone(), g2.clone()]);
    assert_eq!(c["items"][2]["note"], "");
}

#[tokio::test]
async fn add_requires_visible_game() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (zoe, _) = t.register("zoe").await;
    let theirs = game(&t, &mia, "Mia draft", false).await;
    let mine = game(&t, &owner, "My draft", false).await;
    let public = game(&t, &owner, "Public", true).await;
    let cid = mk(&t, &owner, "List", "public").await;

    let r = put_item(&t, Some(&owner), &cid, &theirs, None).await;
    assert_err(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");
    let r = put_item(&t, Some(&owner), &cid, "missing", None).await;
    assert_err(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");

    let v = add(&t, &owner, &cid, &mine).await;
    assert_eq!(v["added"], true);
    assert_eq!(v["item"]["game"]["published"], false);
    add(&t, &owner, &cid, &public).await;

    // Hidden from others, counted for the owner only.
    let v = get_c(&t, Some(&owner), &cid).await.json();
    assert_eq!(item_ids(&v), vec![mine.clone(), public.clone()]);
    assert_eq!(v["gameCount"], 2);
    for tok in [Some(zoe.as_str()), None] {
        let v = get_c(&t, tok, &cid).await.json();
        assert_eq!(item_ids(&v), vec![public.clone()]);
        assert_eq!(v["gameCount"], 1);
    }
}

#[tokio::test]
async fn unavailable_items_and_cascade() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (zoe, _) = t.register("zoe").await;
    let theirs = game(&t, &mia, "Mia game", true).await;
    let mine = game(&t, &owner, "Mine", true).await;
    set_thumb(&t, &theirs).await;
    set_thumb(&t, &mine).await;
    let cid = mk(&t, &owner, "List", "public").await;
    put_item(
        &t,
        Some(&owner),
        &cid,
        &theirs,
        Some(json!({ "note": "Was great" })),
    )
    .await;
    add(&t, &owner, &cid, &mine).await;
    let v = get_c(&t, Some(&zoe), &cid).await.json();
    assert_eq!(v["coverUrls"], json!([thumb(&theirs), thumb(&mine)]));

    set_published(&t, &mia, &theirs, false).await;

    let v = get_c(&t, Some(&owner), &cid).await.json();
    assert_eq!(item_ids(&v), vec![theirs.clone(), mine.clone()]);
    assert_eq!(v["items"][0]["game"], Value::Null);
    assert!(v["items"][0].as_object().unwrap().contains_key("game"));
    assert_eq!(v["items"][0]["note"], "Was great");
    assert!(v["items"][0]["addedAt"].is_string());
    assert_eq!(v["gameCount"], 1);
    assert_eq!(v["coverUrls"], json!([thumb(&mine)]));
    for tok in [Some(zoe.as_str()), None] {
        let v = get_c(&t, tok, &cid).await.json();
        assert_eq!(item_ids(&v), vec![mine.clone()]);
        assert_eq!(v["gameCount"], 1);
        assert_eq!(v["coverUrls"], json!([thumb(&mine)]));
    }
    // List summaries agree.
    let v = t
        .get("/api/users/owen/collections", Some(&zoe))
        .await
        .json();
    assert_eq!(v["items"][0]["gameCount"], 1);
    assert_eq!(v["items"][0]["coverUrls"], json!([thumb(&mine)]));

    // Re-PUT on an unavailable item still updates the note; the item response has game: null.
    let v = put_item(
        &t,
        Some(&owner),
        &cid,
        &theirs,
        Some(json!({ "note": "Gone?" })),
    )
    .await
    .json();
    assert_eq!(v["added"], false);
    assert_eq!(v["item"]["game"], Value::Null);
    assert_eq!(v["item"]["note"], "Gone?");
    assert_eq!(v["gameCount"], 1);

    // Removing an invisible game works.
    let v = remove(&t, Some(&owner), &cid, &theirs).await.json();
    assert_eq!(v["removed"], true);
    assert_eq!(v["gameCount"], 1);

    // Deleting a game removes its items (cascade).
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{mine}"),
            Some(&owner),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM collection_games WHERE collection_id = ?",
            &cid
        )
        .await,
        0
    );
    assert_eq!(
        get_c(&t, Some(&owner), &cid).await.json()["items"],
        json!([])
    );
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reorder_rules() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let a = game(&t, &owner, "A", true).await;
    let b = game(&t, &owner, "B", true).await;
    let c = game(&t, &mia, "C", true).await;
    let cid = mk(&t, &owner, "List", "public").await;
    for g in [&a, &b, &c] {
        add(&t, &owner, &cid, g).await;
    }
    let start = get_c(&t, None, &cid).await.json()["updatedAt"].clone();

    tick().await;
    let r = reorder(&t, Some(&owner), &cid, json!({ "gameIds": [c, a, b] })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(item_ids(&v), vec![c.clone(), a.clone(), b.clone()]);
    assert_eq!(v["isOwner"], true);
    assert_ne!(v["updatedAt"], start);
    assert_eq!(
        positions(&t, &cid).await,
        vec![(c.clone(), 0), (a.clone(), 1), (b.clone(), 2)]
    );
    let moved = v["updatedAt"].clone();

    // Same order → no bump.
    tick().await;
    let v = reorder(&t, Some(&owner), &cid, json!({ "gameIds": [c, a, b] }))
        .await
        .json();
    assert_eq!(v["updatedAt"], moved);

    let conflict = "The collection has changed; reload and try again";
    for ids in [
        json!([c, a]),
        json!([c, a, b, "x"]),
        json!([c, a, "x"]),
        json!([]),
    ] {
        let r = reorder(&t, Some(&owner), &cid, json!({ "gameIds": ids })).await;
        assert_err(&r, StatusCode::CONFLICT, "conflict", conflict);
    }
    for body in [
        json!({ "gameIds": [c, a, a] }),
        json!({ "gameIds": [c, a, 5] }),
        json!({ "gameIds": "abc" }),
        json!({ "gameIds": null }),
        json!({}),
        json!({ "gameIds": (0..101).map(|i| i.to_string()).collect::<Vec<_>>() }),
    ] {
        let r = reorder(&t, Some(&owner), &cid, body).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    }

    // Unavailable items must be included.
    set_published(&t, &mia, &c, false).await;
    let r = reorder(&t, Some(&owner), &cid, json!({ "gameIds": [b, a] })).await;
    assert_err(&r, StatusCode::CONFLICT, "conflict", conflict);
    let r = reorder(&t, Some(&owner), &cid, json!({ "gameIds": [b, c, a] })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(item_ids(&v), vec![b.clone(), c.clone(), a.clone()]);
    assert_eq!(v["items"][1]["game"], Value::Null);
    // Others see the visible order.
    let v = get_c(&t, None, &cid).await.json();
    assert_eq!(item_ids(&v), vec![b.clone(), a.clone()]);
}

// ---------------------------------------------------------------------------
// Caps and concurrency
// ---------------------------------------------------------------------------

#[tokio::test]
async fn collection_cap_is_50() {
    let t = setup().await;
    let (tok, _) = t.register("owen").await;
    let gid = game(&t, &tok, "Space Dodge", true).await;
    for i in 0..50 {
        mk(&t, &tok, &format!("C{i}"), "private").await;
    }
    let msg = "You can have at most 50 collections";
    let r = create(&t, Some(&tok), json!({ "title": "C51" })).await;
    assert_err(&r, StatusCode::UNPROCESSABLE_ENTITY, "validation", msg);
    // With a game: nothing is created either.
    let r = create(&t, Some(&tok), json!({ "title": "C51", "gameId": gid })).await;
    assert_err(&r, StatusCode::UNPROCESSABLE_ENTITY, "validation", msg);
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM collection_games WHERE game_id = ?",
            &gid
        )
        .await,
        0
    );
    let v = t.get("/api/users/me/collections", Some(&tok)).await.json();
    assert_eq!(v.as_array().unwrap().len(), 50);
    // Another user is unaffected.
    let (mia, _) = t.register("mia").await;
    mk(&t, &mia, "Mine", "public").await;
}

#[tokio::test]
async fn game_cap_is_100() {
    let t = setup().await;
    let (tok, uid) = t.register("owen").await;
    let ids = insert_games(&t, &uid, 101, "g").await;
    let cid = mk(&t, &tok, "Big", "public").await;
    for (i, g) in ids.iter().take(99).enumerate() {
        sqlx::query(
            "INSERT INTO collection_games (collection_id, game_id, position, added_at) \
             VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .bind(&cid)
        .bind(g)
        .bind(i as i64)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let v = add(&t, &tok, &cid, &ids[99]).await;
    assert_eq!(v["added"], true);
    assert_eq!(v["gameCount"], 100);
    let r = put_item(&t, Some(&tok), &cid, &ids[100], None).await;
    assert_err(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "A collection can hold at most 100 games",
    );
    // An existing item still gets its note updated at the cap.
    let r = put_item(
        &t,
        Some(&tok),
        &cid,
        &ids[0],
        Some(json!({ "note": "first" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["added"], false);
    assert_eq!(r.json()["item"]["note"], "first");
    let c = get_c(&t, None, &cid).await.json();
    assert_eq!(c["items"].as_array().unwrap().len(), 100);
    assert_eq!(c["gameCount"], 100);
    let v = t.get("/api/users/me/collections", Some(&tok)).await.json();
    assert_eq!(v[0]["itemCount"], 100);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_adds_never_exceed_100() {
    let t = setup().await;
    let (tok, uid) = t.register("owen").await;
    let ids = insert_games(&t, &uid, 105, "p").await;
    let cid = mk(&t, &tok, "Race", "public").await;
    for (i, g) in ids.iter().take(95).enumerate() {
        sqlx::query(
            "INSERT INTO collection_games (collection_id, game_id, position, added_at) \
             VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .bind(&cid)
        .bind(g)
        .bind(i as i64)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let mut set = tokio::task::JoinSet::new();
    // 10 distinct new games, all in flight at once.
    for g in ids.iter().skip(95) {
        let router = t.router.clone();
        let req = Request::builder()
            .method(Method::PUT)
            .uri(format!("/api/collections/{cid}/games/{g}"))
            .header("host", "localhost:8080")
            .header("authorization", format!("Bearer {tok}"))
            .body(Body::empty())
            .unwrap();
        set.spawn(async move { router.oneshot(req).await.unwrap().status() });
    }
    let mut ok = 0;
    let mut capped = 0;
    while let Some(status) = set.join_next().await {
        match status.unwrap() {
            StatusCode::OK => ok += 1,
            StatusCode::UNPROCESSABLE_ENTITY => capped += 1,
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!((ok, capped), (5, 5));
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM collection_games WHERE collection_id = ?",
            &cid
        )
        .await,
        100
    );
    // Positions stay distinct.
    let pos = positions(&t, &cid).await;
    let distinct: std::collections::HashSet<i64> = pos.iter().map(|(_, p)| *p).collect();
    assert_eq!(distinct.len(), 100);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

#[tokio::test]
async fn user_collections_paging_and_order() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let mut cids = Vec::new();
    for i in 0..3 {
        let r = create(
            &t,
            Some(&owner),
            json!({ "title": format!("C{i}"), "gameId": gid }),
        )
        .await;
        assert_eq!(r.status, StatusCode::CREATED);
        cids.push(s(&r.json()["id"]));
        tick().await;
    }
    let v = t
        .get("/api/users/OWEN/collections?perPage=2", Some(&mia))
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 2);
    assert_eq!(
        list_ids(&v["items"]),
        vec![cids[2].clone(), cids[1].clone()]
    );
    assert_eq!(v["items"][0]["gameCount"], 1);
    assert_eq!(v["items"][0]["path"], format!("/c/{}", cids[2]));
    assert!(v["items"][0].get("items").is_none());
    let v = t
        .get("/api/users/owen/collections?perPage=2&page=2", None)
        .await
        .json();
    assert_eq!(list_ids(&v["items"]), vec![cids[0].clone()]);

    // An add bumps a collection to the top.
    let other = game(&t, &owner, "Other", true).await;
    add(&t, &owner, &cids[0], &other).await;
    let v = t.get("/api/users/owen/collections", None).await.json();
    assert_eq!(
        list_ids(&v["items"]),
        vec![cids[0].clone(), cids[2].clone(), cids[1].clone()]
    );
    assert_eq!(v["perPage"], 24);
    // perPage clamps; bad paging → 400; unknown user → 404.
    let v = t
        .get("/api/users/owen/collections?perPage=500", None)
        .await
        .json();
    assert_eq!(v["perPage"], 100);
    let r = t.get("/api/users/owen/collections?page=abc", None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = t.get("/api/users/nobody/collections", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn my_collections_contains_game_and_item_count() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let g1 = game(&t, &owner, "One", true).await;
    let theirs = game(&t, &mia, "Theirs", true).await;
    let hidden = game(&t, &mia, "Hidden", false).await;
    let a = mk(&t, &owner, "A", "public").await;
    tick().await;
    let b = mk(&t, &owner, "B", "private").await;
    add(&t, &owner, &a, &g1).await;
    add(&t, &owner, &a, &theirs).await;
    set_published(&t, &mia, &theirs, false).await;
    // Mia's own collection with g1 must not leak into mine.
    let m = mk(&t, &mia, "M", "public").await;
    add(&t, &mia, &m, &g1).await;

    let r = t.get("/api/users/me/collections", None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    let v = t
        .get(
            &format!("/api/users/me/collections?gameId={g1}"),
            Some(&owner),
        )
        .await
        .json();
    let arr = v.as_array().unwrap();
    assert_eq!(list_ids(&v), vec![a.clone(), b.clone()]);
    assert_eq!(arr[0]["containsGame"], true);
    assert_eq!(arr[0]["itemCount"], 2);
    assert_eq!(arr[0]["gameCount"], 1);
    assert_eq!(arr[1]["containsGame"], false);
    assert_eq!(arr[1]["itemCount"], 0);
    assert_eq!(arr[1]["visibility"], "private");

    for q in [
        String::new(),
        "?gameId=unknown".to_string(),
        format!("?gameId={hidden}"),
        format!("?gameId={theirs}"),
    ] {
        let v = t
            .get(&format!("/api/users/me/collections{q}"), Some(&owner))
            .await
            .json();
        for c in v.as_array().unwrap() {
            assert_eq!(c["containsGame"], false, "{q}");
        }
        assert_eq!(v[0]["itemCount"], 2);
    }
}

#[tokio::test]
async fn game_collections_shelf() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let draft = game(&t, &owner, "Draft", false).await;
    let mut public = Vec::new();
    for i in 0..3 {
        let r = create(
            &t,
            Some(&mia),
            json!({ "title": format!("P{i}"), "gameId": gid }),
        )
        .await;
        public.push(s(&r.json()["id"]));
        tick().await;
    }
    let r = create(
        &t,
        Some(&mia),
        json!({ "title": "Private", "gameId": gid, "visibility": "private" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED);

    let v = t
        .get(&format!("/api/games/{gid}/collections"), None)
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(
        list_ids(&v["items"]),
        vec![public[2].clone(), public[1].clone(), public[0].clone()]
    );
    assert_eq!(v["items"][0]["owner"]["username"], "mia");
    let v = t
        .get(&format!("/api/games/{gid}/collections?limit=0"), Some(&mia))
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    let v = t
        .get(&format!("/api/games/{gid}/collections?limit=2"), None)
        .await
        .json();
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    let v = t
        .get(&format!("/api/games/{gid}/collections?limit=1000"), None)
        .await
        .json();
    assert_eq!(v["items"].as_array().unwrap().len(), 3);
    let r = t
        .get(&format!("/api/games/{gid}/collections?limit=abc"), None)
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    // Unpublished game: 404 for strangers, OK for its owner.
    let r = t
        .get(&format!("/api/games/{draft}/collections"), Some(&mia))
        .await;
    assert_err(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");
    let r = t
        .get(&format!("/api/games/{draft}/collections"), Some(&owner))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["total"], 0);
    let r = t.get("/api/games/missing/collections", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cover_urls() {
    let t = setup().await;
    let (owner, uid) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let mine = insert_games(&t, &uid, 6, "c").await;
    let theirs = insert_games(&t, &mia_id, 1, "m").await;
    // Order: no thumb, thumb, (mia's, later unpublished, thumb), thumb, thumb, thumb, thumb.
    for g in &mine[1..] {
        set_thumb(&t, g).await;
    }
    set_thumb(&t, &theirs[0]).await;
    let cid = mk(&t, &owner, "Covers", "public").await;
    let order = [
        &mine[0], &mine[1], &theirs[0], &mine[2], &mine[3], &mine[4], &mine[5],
    ];
    for g in order {
        add(&t, &owner, &cid, g).await;
    }
    let v = get_c(&t, None, &cid).await.json();
    assert_eq!(
        v["coverUrls"],
        json!([
            thumb(&mine[1]),
            thumb(&theirs[0]),
            thumb(&mine[2]),
            thumb(&mine[3])
        ])
    );
    assert_eq!(v["gameCount"], 7);

    sqlx::query("UPDATE games SET published = 0 WHERE id = ?")
        .bind(&theirs[0])
        .execute(&t.state.db)
        .await
        .unwrap();
    let expected = json!([
        thumb(&mine[1]),
        thumb(&mine[2]),
        thumb(&mine[3]),
        thumb(&mine[4])
    ]);
    let v = get_c(&t, Some(&owner), &cid).await.json();
    assert_eq!(v["coverUrls"], expected);
    assert_eq!(v["gameCount"], 6);
    let v = t.get("/api/users/owen/collections", None).await.json();
    assert_eq!(v["items"][0]["coverUrls"], expected);
    // Mia owns the hidden game, so her summary includes it.
    let v = t
        .get("/api/users/owen/collections", Some(&mia))
        .await
        .json();
    assert_eq!(v["items"][0]["coverUrls"][1], thumb(&theirs[0]));
    assert_eq!(v["items"][0]["gameCount"], 7);
    let v = t
        .get("/api/users/me/collections", Some(&owner))
        .await
        .json();
    assert_eq!(v[0]["coverUrls"], expected);
    assert_eq!(v[0]["itemCount"], 7);
    // Mia (the hidden game's owner) still sees her game in the covers.
    let v = get_c(&t, Some(&mia), &cid).await.json();
    assert_eq!(v["coverUrls"][1], thumb(&theirs[0]));
    let v = t
        .get(&format!("/api/games/{}/collections", mine[1]), None)
        .await
        .json();
    assert_eq!(v["items"][0]["coverUrls"], expected);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[tokio::test]
async fn collection_reports() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (boss, _) = t.register("boss").await;
    let (mia, _) = t.register("mia").await;
    let (zoe, _) = t.register("zoe").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let cid = mk(&t, &owner, &"T".repeat(60), "public").await;
    add(&t, &owner, &cid, &gid).await;

    let r = report(&t, &mia, "collection", &cid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rep = r.json();
    assert_eq!(rep["targetType"], "collection");
    assert_eq!(rep["targetId"], cid.as_str());
    assert_eq!(rep["targetGameId"], Value::Null);
    assert_eq!(rep["targetImageUrl"], Value::Null);
    assert_eq!(rep["targetImageFullUrl"], Value::Null);
    assert_eq!(rep["targetPreview"], "T".repeat(60));
    let r1 = s(&rep["id"]);
    let r = report(&t, &mia, "collection", &cid).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let r2 = s(&report(&t, &zoe, "collection", &cid).await.json()["id"]);
    // A game report on the same game is untouched by the collection resolve.
    let rg = report(&t, &zoe, "game", &gid).await;
    assert_eq!(rg.status, StatusCode::CREATED);
    assert_eq!(rg.json()["targetGameId"], gid.as_str());
    let rg = s(&rg.json()["id"]);

    let r = report(&t, &mia, "collection", "missing").await;
    assert_404(&r);
    let r = report(&t, &mia, "bogus", &cid).await;
    assert_err(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "targetType must be \"game\", \"comment\", \"screenshot\" or \"collection\"",
    );

    // Admin list shows the collection rows with a null game id.
    let v = t
        .get("/api/admin/reports?status=open", Some(&boss))
        .await
        .json();
    assert_eq!(v["total"], 3);
    let row = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == r1.as_str())
        .unwrap();
    assert_eq!(row["targetGameId"], Value::Null);

    let r = resolve(&t, &boss, &r1, "unpublish").await;
    assert_err(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "unpublish is only valid for game reports",
    );
    let r = resolve(&t, &boss, &r1, "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["status"], "resolved");
    assert_eq!(r.json()["resolution"], "delete");
    assert_404(&get_c(&t, Some(&boss), &cid).await);
    let resolved = ("resolved".to_string(), Some("delete".to_string()));
    assert_eq!(report_state(&t, &r2).await, resolved);
    assert_eq!(report_state(&t, &rg).await, ("open".to_string(), None));
    assert_eq!(
        t.get(&format!("/api/games/{gid}"), None).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn delete_resolves_reports_and_gone_target_is_ok() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (boss, _) = t.register("boss").await;
    let (mia, _) = t.register("mia").await;
    let cid = mk(&t, &owner, "Bad", "public").await;
    let r1 = s(&report(&t, &mia, "collection", &cid).await.json()["id"]);
    // The owner deletes it: open reports resolve with `delete`.
    assert_eq!(
        del(&t, Some(&owner), &cid).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        report_state(&t, &r1).await,
        ("resolved".to_string(), Some("delete".to_string()))
    );

    // A report whose collection is already gone resolves without error.
    let cid = mk(&t, &owner, "Bad 2", "public").await;
    let r2 = s(&report(&t, &mia, "collection", &cid).await.json()["id"]);
    sqlx::query("DELETE FROM collections WHERE id = ?")
        .bind(&cid)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = resolve(&t, &boss, &r2, "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // Dismiss on a collection report is unchanged.
    let cid = mk(&t, &owner, "Fine", "public").await;
    let r3 = s(&report(&t, &mia, "collection", &cid).await.json()["id"]);
    let r = resolve(&t, &boss, &r3, "dismiss").await;
    assert_eq!(r.json()["resolution"], "dismiss");
    assert_eq!(get_c(&t, None, &cid).await.status, StatusCode::OK);
    // Admins can report private collections they can see; strangers can't.
    let p = mk(&t, &owner, "Private", "private").await;
    assert_eq!(
        report(&t, &boss, "collection", &p).await.status,
        StatusCode::CREATED
    );
}

// ---------------------------------------------------------------------------
// Migration upgrade (0015 → 0016)
// ---------------------------------------------------------------------------

type ReportRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);

#[tokio::test]
async fn migration_upgrade_from_0015() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let rows_sql = "SELECT id, target_type, target_id, target_game_id, target_preview, reason, \
                    details, reporter_id, status, resolution, created_at, resolved_at \
                    FROM reports ORDER BY rowid";
    let idx_sql = "SELECT name, sql FROM sqlite_master WHERE type = 'index' \
                   AND tbl_name = 'reports' AND sql IS NOT NULL ORDER BY name";
    let trig_sql = "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name";

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        data.join("webgame.db").to_string_lossy().replace('\\', "/")
    );
    let (before, idx_before, trig_before) = {
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
                .filter(|x| x.version <= 15)
                .cloned()
                .collect(),
        );
        m.run(&db).await.unwrap();
        for sql in [
            "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
             display_name, created_at, role) VALUES \
             ('u1', 'Rep', 'rep', 'r@x', 'r@x', 'h', 'Rep', '2026-01-01T00:00:00.000Z', 'user'), \
             ('u2', 'boss', 'boss', 'b@x', 'b@x', 'h', 'Boss', '2026-01-01T00:00:00.000Z', \
              'admin')",
            "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, \
             updated_at, actions_json, controls_hint) VALUES \
             ('g1', 'u2', 'Old', 'main.js', 800, 600, '2026-01-01T00:00:00.000Z', \
              '2026-01-01T00:00:00.000Z', '[]', '')",
            // Ids deliberately out of alphabetical order so rowid order is observable; equal
            // created_at on two rows so the admin list's rowid tie-break matters.
            "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, \
             reason, details, reporter_id, status, resolution, created_at, resolved_at) VALUES \
             ('r9', 'game', 'g1', 'g1', 'A game', 'spam', 'd1', 'u1', 'open', NULL, \
              '2026-01-02T00:00:00.000Z', NULL), \
             ('r1', 'comment', 'c1', 'g1', 'A comment', 'offensive', '', 'u1', 'resolved', \
              'delete', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'), \
             ('r5', 'screenshot', 's1', 'g1', 'Screenshot by Rep', 'other', 'x', 'u2', 'open', \
              NULL, '2026-01-01T00:00:00.000Z', NULL)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        let before: Vec<ReportRow> = sqlx::query_as(rows_sql).fetch_all(&db).await.unwrap();
        let idx: Vec<(String, String)> = sqlx::query_as(idx_sql).fetch_all(&db).await.unwrap();
        let trig: Vec<(String, String)> = sqlx::query_as(trig_sql).fetch_all(&db).await.unwrap();
        assert_eq!(before.len(), 3);
        assert_eq!(idx.len(), 3);
        // The rebuild relies on reports having no triggers and no referencing tables.
        assert!(trig.iter().all(|(_, tbl)| tbl != "reports"), "{trig:?}");
        let refs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master m, pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' AND f.\"table\" = 'reports'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(refs, 0);
        db.close().await;
        (before, idx, trig)
    };

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    config.admin_usernames = vec!["boss".into()];
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    let after: Vec<ReportRow> = sqlx::query_as(rows_sql).fetch_all(&db).await.unwrap();
    assert_eq!(before, after);
    let idx_after: Vec<(String, String)> = sqlx::query_as(idx_sql).fetch_all(&db).await.unwrap();
    assert_eq!(idx_before, idx_after);
    let trig_after: Vec<(String, String)> = sqlx::query_as(trig_sql).fetch_all(&db).await.unwrap();
    assert_eq!(trig_before, trig_after);
    let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&db)
        .await
        .unwrap();
    assert!(fk.is_empty());
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    // The new tables exist with their indices.
    let new_idx: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN \
         ('idx_collections_owner_updated', 'idx_collection_games_order', \
          'idx_collection_games_game')",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(new_idx, 3);

    // The DB no longer checks target_type (TARGET_TYPES in Rust does) and allows a NULL game.
    sqlx::query(
        "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, \
         reason, reporter_id, created_at) VALUES \
         ('r20', 'something-new', 'x', NULL, 'p', 'spam', 'u1', '2026-01-04T00:00:00.000Z')",
    )
    .execute(&db)
    .await
    .unwrap();
    let st: String = sqlx::query_scalar("SELECT status FROM reports WHERE id = 'r20'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(st, "open");
    // The status CHECK is kept.
    let bad = sqlx::query(
        "INSERT INTO reports (id, target_type, target_id, target_preview, reason, reporter_id, \
         status, created_at) VALUES ('r21', 'game', 'g1', 'p', 'spam', 'u1', 'weird', 't')",
    )
    .execute(&db)
    .await;
    assert!(bad.is_err());

    // The API reads the migrated rows (admin list order: created_at desc, then rowid desc).
    let t = TestApp {
        router: webgame_server::app(state.clone()),
        state,
        dir,
        clock: webgame_server::ratelimit::ManualClock::new(),
    };
    let token = webgame_server::auth::create_token("test-secret", "u2").unwrap();
    let v = t.get("/api/admin/reports", Some(&token)).await.json();
    assert_eq!(v["total"], 4);
    assert_eq!(list_ids(&v["items"]), vec!["r20", "r1", "r9", "r5"]);
    let items = v["items"].as_array().unwrap();
    assert_eq!(items[0]["targetGameId"], Value::Null);
    assert_eq!(items[1]["targetGameId"], "g1");
    assert_eq!(items[1]["resolution"], "delete");
    assert_eq!(items[2]["targetType"], "game");
    assert_eq!(items[3]["targetType"], "screenshot");
    // An unknown-type row can still be dismissed.
    let r = resolve(&t, &token, "r20", "dismiss").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------------------
// Rate limit (ManualClock)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn collection_writes_share_one_bucket() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let g1 = game(&t, &owner, "One", true).await;
    let g2 = game(&t, &owner, "Two", true).await;

    // 1 create + 119 mixed writes = 120.
    let cid = mk(&t, &owner, "Busy", "public").await;
    add(&t, &owner, &cid, &g1).await;
    add(&t, &owner, &cid, &g2).await;
    let mut n = 3;
    let mut i = 0;
    while n < 120 {
        let r = match i % 5 {
            0 => {
                patch(
                    &t,
                    Some(&owner),
                    &cid,
                    json!({ "description": format!("d{i}") }),
                )
                .await
            }
            1 => {
                put_item(
                    &t,
                    Some(&owner),
                    &cid,
                    &g1,
                    Some(json!({ "note": format!("n{i}") })),
                )
                .await
            }
            2 => reorder(&t, Some(&owner), &cid, json!({ "gameIds": [g2, g1] })).await,
            3 => remove(&t, Some(&owner), &cid, "not-in-it").await,
            _ => reorder(&t, Some(&owner), &cid, json!({ "gameIds": [g1, g2] })).await,
        };
        assert_eq!(r.status, StatusCode::OK, "write #{n}: {}", r.text());
        // Reads don't consume the bucket.
        assert_eq!(get_c(&t, Some(&owner), &cid).await.status, StatusCode::OK);
        assert_eq!(
            t.get("/api/users/me/collections", Some(&owner))
                .await
                .status,
            StatusCode::OK
        );
        n += 1;
        i += 1;
    }
    for r in [
        create(&t, Some(&owner), json!({ "title": "x" })).await,
        // 429 comes before body validation.
        patch(&t, Some(&owner), &cid, json!({ "title": "" })).await,
        del(&t, Some(&owner), &cid).await,
    ] {
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
        assert_eq!(r.error_code(), "rate_limited");
        assert_eq!(r.header("retry-after"), "5");
    }
    // Reads still work; another user has their own bucket; 403 is checked before 429.
    assert_eq!(get_c(&t, None, &cid).await.status, StatusCode::OK);
    assert_eq!(
        t.get("/api/users/owen/collections", None).await.status,
        StatusCode::OK
    );
    assert_eq!(
        t.get(&format!("/api/games/{g1}/collections"), None)
            .await
            .status,
        StatusCode::OK
    );
    mk(&t, &mia, "Mine", "public").await;
    assert_eq!(
        patch(&t, Some(&mia), &cid, json!({ "title": "x" }))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    t.clock.advance(Duration::from_secs(5));
    let r = patch(&t, Some(&owner), &cid, json!({ "title": "Calm" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = patch(&t, Some(&owner), &cid, json!({ "title": "Again" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

// ---------------------------------------------------------------------------
// Routing and seed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn me_route_is_static() {
    let t = setup().await;
    let (tok, _) = t.register("owen").await;
    mk(&t, &tok, "Mine", "private").await;
    let v = t.get("/api/users/me/collections", Some(&tok)).await.json();
    assert!(v.is_array());
    assert_eq!(v[0]["title"], "Mine");
    // A user named "me" can't exist, so the dynamic route never sees it.
    let r = t.get("/api/users/me", Some(&tok)).await;
    assert_ne!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn demo_seed_collection_is_idempotent() {
    use webgame_server::seed;
    let t = setup().await;
    let (tok, uid) = t.register("demo_user").await;
    let mut ids = Vec::new();
    for (title, _) in seed::DEMO_COLLECTION_GAMES.iter().rev() {
        ids.push(game(&t, &tok, title, true).await);
    }
    ids.reverse();
    let cid = seed::seed_collection(&t.state, &uid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        seed::seed_collection(&t.state, &uid)
            .await
            .unwrap()
            .is_none()
    );
    let v = get_c(&t, None, &cid).await.json();
    assert_eq!(v["title"], seed::DEMO_COLLECTION_TITLE);
    assert_eq!(v["description"], "Four short games to try first.");
    assert_eq!(v["visibility"], "public");
    assert_eq!(item_ids(&v), ids);
    let titles: Vec<String> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| s(&i["game"]["title"]))
        .collect();
    assert_eq!(
        titles,
        vec![
            "Space Dodge",
            "Brick Breaker",
            "Pixel Peaks",
            "Ember Garden"
        ]
    );
    for i in v["items"].as_array().unwrap() {
        assert!(!s(&i["note"]).is_empty());
    }
    let n = count(
        &t,
        "SELECT COUNT(*) FROM collections WHERE owner_id = ?",
        &uid,
    )
    .await;
    assert_eq!(n, 1);
}
