//! F020: game comment settings (on / repliesOnly / off, slow mode): defaults, the settings
//! endpoint (permissions, validation, shared `ThreadTools` limit), both modes with exemptions,
//! slow mode (backdated via SQL), slot accounting, concurrency, validation order, the 0021
//! migration and the game-delete cascade.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

const OFF_MSG: &str = "Comments are turned off for this game";
const REPLIES_ONLY_MSG: &str = "New comments are turned off for this game";
const MODE_MSG: &str = "mode must be one of: on, repliesOnly, off";
const SECS_MSG: &str = "slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600";
const OBJECT_MSG: &str = "Body must be a JSON object";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
}

async fn game(t: &TestApp, owner: &str, published: bool) -> String {
    let g = t.create_game(owner, "Pixel Peaks", "", published).await;
    g["id"].as_str().unwrap().to_string()
}

async fn post(t: &TestApp, tok: &str, gid: &str, body: Value) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/games/{gid}/comments"),
        Some(tok),
        body,
    )
    .await
}

async fn top(t: &TestApp, tok: &str, gid: &str) -> Resp {
    post(t, tok, gid, json!({ "body": "hello" })).await
}

async fn reply(t: &TestApp, tok: &str, gid: &str, parent: &str) -> Resp {
    post(
        t,
        tok,
        gid,
        json!({ "body": "a reply", "parentId": parent }),
    )
    .await
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

/// A created comment's id (asserts 201).
fn created(r: &Resp) -> String {
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    id(&r.json())
}

async fn list(t: &TestApp, tok: Option<&str>, gid: &str) -> Value {
    let r = t.get(&format!("/api/games/{gid}/comments"), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn put_settings(t: &TestApp, tok: Option<&str>, gid: &str, body: Value) -> Resp {
    t.json(
        Method::PUT,
        &format!("/api/games/{gid}/comment-settings"),
        tok,
        body,
    )
    .await
}

async fn set(t: &TestApp, tok: &str, gid: &str, mode: &str, secs: i64) {
    let r = put_settings(
        t,
        Some(tok),
        gid,
        json!({ "mode": mode, "slowModeSecs": secs }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), json!({ "mode": mode, "slowModeSecs": secs }));
}

fn assert_message(r: &Resp, status: StatusCode, code: &str, message: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    assert_eq!(r.error_code(), code);
    assert_eq!(r.json()["error"]["message"], message);
}

fn assert_validation(r: &Resp, message: &str) {
    assert_message(r, StatusCode::UNPROCESSABLE_ENTITY, "validation", message);
}

/// A 429 `slow_mode` with `Retry-After` in `1..=max`, whose message names the same number.
fn assert_slow(r: &Resp, max: u64) -> u64 {
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    assert_eq!(r.error_code(), "slow_mode");
    let n: u64 = r.header("retry-after").parse().unwrap();
    assert!((1..=max).contains(&n), "Retry-After {n} not in 1..={max}");
    assert_eq!(
        r.json()["error"]["message"],
        format!("Slow mode is on: you can post again in {n} seconds")
    );
    n
}

/// Move a user's last-post time on a game `secs` seconds into the past (relative to now).
async fn backdate(t: &TestApp, gid: &str, uid: &str, secs: i64) {
    let done = sqlx::query(
        "UPDATE comment_post_times \
         SET last_posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) \
         WHERE game_id = ? AND user_id = ?",
    )
    .bind(format!("-{secs} seconds"))
    .bind(gid)
    .bind(uid)
    .execute(&t.state.db)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(done, 1);
}

async fn bulk_replies(t: &TestApp, gid: &str, author: &str, root: &str, n: usize) {
    for i in 0..n {
        sqlx::query(
            "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) \
             VALUES (?, ?, ?, 'r', '2026-01-01T00:00:00.000Z', ?)",
        )
        .bind(format!("bulk-{root}-{i}"))
        .bind(gid)
        .bind(author)
        .bind(root)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
}

async fn lock(t: &TestApp, tok: &str, cid: &str) {
    let r = t
        .send(
            Method::PUT,
            &format!("/api/comments/{cid}/lock"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn comment_count(t: &TestApp, gid: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE game_id = ?")
        .bind(gid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

#[tokio::test]
async fn defaults_on_game_and_list() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;

    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(
        g["commentSettings"],
        json!({ "mode": "on", "slowModeSecs": 0 })
    );
    let g = t.get(&format!("/api/games/{gid}"), Some(&mia)).await.json();
    assert_eq!(
        g["commentSettings"],
        json!({ "mode": "on", "slowModeSecs": 0 })
    );

    let plain = json!({ "mode": "on", "slowModeSecs": 0, "canManage": false, "waitSecs": 0 });
    assert_eq!(list(&t, None, &gid).await["settings"], plain);
    assert_eq!(list(&t, Some(&mia), &gid).await["settings"], plain);
    let manage = json!({ "mode": "on", "slowModeSecs": 0, "canManage": true, "waitSecs": 0 });
    assert_eq!(list(&t, Some(&owner), &gid).await["settings"], manage);
    assert_eq!(list(&t, Some(&boss), &gid).await["settings"], manage);
}

// ---------------------------------------------------------------------------
// PUT …/comment-settings: permissions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_permissions_and_reflection() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let hidden = game(&t, &owner, false).await;
    let body = json!({ "mode": "repliesOnly", "slowModeSecs": 300 });
    let before = t.get(&format!("/api/games/{gid}"), None).await.json();

    let r = put_settings(&t, None, &gid, body.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = put_settings(&t, Some(&mia), &gid, body.clone()).await;
    assert_message(
        &r,
        StatusCode::FORBIDDEN,
        "forbidden",
        "You do not have permission to do that",
    );
    let r = put_settings(&t, Some(&mia), "no-such-game", body.clone()).await;
    assert_message(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");
    let r = put_settings(&t, Some(&mia), &hidden, body.clone()).await;
    assert_message(&r, StatusCode::NOT_FOUND, "not_found", "Game not found");
    // The admin can't see someone else's unpublished game either.
    let r = put_settings(&t, Some(&boss), &hidden, body.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // The owner can change an unpublished game's settings.
    set(&t, &owner, &hidden, "off", 0).await;

    set(&t, &owner, &gid, "repliesOnly", 300).await;
    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(g["commentSettings"], body);
    assert_eq!(g["updatedAt"], before["updatedAt"]);
    assert_eq!(g["lastUpdatedAt"], before["lastUpdatedAt"]);
    let s = list(&t, Some(&mia), &gid).await["settings"].clone();
    assert_eq!(
        s,
        json!({ "mode": "repliesOnly", "slowModeSecs": 300, "canManage": false, "waitSecs": 0 })
    );

    // Idempotent; the admin may change someone else's published game.
    set(&t, &boss, &gid, "off", 60).await;
    set(&t, &boss, &gid, "off", 60).await;
    let g = t
        .get(&format!("/api/games/{gid}"), Some(&owner))
        .await
        .json();
    assert_eq!(
        g["commentSettings"],
        json!({ "mode": "off", "slowModeSecs": 60 })
    );
    assert_eq!(g["updatedAt"], before["updatedAt"]);
    let s = list(&t, Some(&boss), &gid).await["settings"].clone();
    assert_eq!(
        s,
        json!({ "mode": "off", "slowModeSecs": 60, "canManage": true, "waitSecs": 0 })
    );
    // No notifications for anyone.
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notifications")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------------------
// PUT …/comment-settings: validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_validation_messages() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let gid = game(&t, &owner, true).await;
    let uri = format!("/api/games/{gid}/comment-settings");

    let r = t
        .send(
            Method::PUT,
            &uri,
            Some(&owner),
            Some("application/json"),
            b"{\"mode\": ".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    assert_eq!(r.error_code(), "bad_request");

    for body in [json!([]), json!("x"), json!(5), json!(null)] {
        let r = put_settings(&t, Some(&owner), &gid, body.clone()).await;
        assert_validation(&r, OBJECT_MSG);
    }
    for body in [
        json!({ "slowModeSecs": 0 }),
        json!({ "mode": "closed", "slowModeSecs": 0 }),
        json!({ "mode": 1, "slowModeSecs": 0 }),
        json!({ "mode": null, "slowModeSecs": 0 }),
        json!({ "mode": "ON", "slowModeSecs": 0 }),
        json!({ "mode": "replies_only", "slowModeSecs": 0 }),
    ] {
        let r = put_settings(&t, Some(&owner), &gid, body.clone()).await;
        assert_validation(&r, MODE_MSG);
    }
    for secs in [
        json!(45),
        json!("60"),
        json!(60.5),
        json!(60.0),
        json!(-1),
        json!(true),
        json!(null),
    ] {
        let r = put_settings(
            &t,
            Some(&owner),
            &gid,
            json!({ "mode": "on", "slowModeSecs": secs }),
        )
        .await;
        assert_validation(&r, SECS_MSG);
    }
    let r = put_settings(&t, Some(&owner), &gid, json!({ "mode": "on" })).await;
    assert_validation(&r, SECS_MSG);
    // Both wrong: the mode message (order).
    let r = put_settings(
        &t,
        Some(&owner),
        &gid,
        json!({ "mode": "closed", "slowModeSecs": 45 }),
    )
    .await;
    assert_validation(&r, MODE_MSG);
    // Nothing was stored.
    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(
        g["commentSettings"],
        json!({ "mode": "on", "slowModeSecs": 0 })
    );
    // Unknown extra fields are ignored; every allowed value is accepted.
    let r = put_settings(
        &t,
        Some(&owner),
        &gid,
        json!({ "mode": "off", "slowModeSecs": 3600, "foo": 1 }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), json!({ "mode": "off", "slowModeSecs": 3600 }));
    for secs in [0, 30, 60, 300, 900, 3600] {
        for mode in ["on", "repliesOnly", "off"] {
            set(&t, &owner, &gid, mode, secs).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Rate limit (ManualClock)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_share_thread_tools_bucket() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = created(&top(&t, &mia, &gid).await);
    let pin_uri = format!("/api/comments/{root}/pin");
    let pin = async |t: &TestApp| {
        t.send(Method::PUT, &pin_uri, Some(&owner), None, vec![], &[])
            .await
    };
    for i in 0..60 {
        let r = if i % 2 == 0 {
            put_settings(
                &t,
                Some(&owner),
                &gid,
                json!({ "mode": "on", "slowModeSecs": 0 }),
            )
            .await
        } else {
            pin(&t).await
        };
        assert_eq!(r.status, StatusCode::OK, "call #{i}: {}", r.text());
    }
    let r = put_settings(
        &t,
        Some(&owner),
        &gid,
        json!({ "mode": "on", "slowModeSecs": 0 }),
    )
    .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert_eq!(r.header("retry-after"), "10");
    let r = pin(&t).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    // The limit is checked after the permission check: a stranger still gets 403.
    let r = put_settings(
        &t,
        Some(&mia),
        &gid,
        json!({ "mode": "on", "slowModeSecs": 0 }),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // ... and before body validation.
    let r = put_settings(&t, Some(&owner), &gid, json!([])).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);

    t.clock.advance(Duration::from_secs(10));
    set(&t, &owner, &gid, "off", 0).await;
    let r = pin(&t).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mode_off_blocks_players_but_not_managers() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let root = created(&top(&t, &mia, &gid).await);
    let mine = created(&top(&t, &noah, &gid).await);
    created(&reply(&t, &noah, &gid, &root).await);
    set(&t, &owner, &gid, "off", 0).await;

    assert_validation(&top(&t, &mia, &gid).await, OFF_MSG);
    assert_validation(&reply(&t, &mia, &gid, &root).await, OFF_MSG);
    // Mode before the parent lookup.
    assert_validation(&reply(&t, &mia, &gid, "no-such-comment").await, OFF_MSG);
    // Body length before mode.
    let r = post(&t, &mia, &gid, json!({ "body": "   " })).await;
    assert_validation(&r, "Comment must be 1-2000 characters");
    // parentId type before mode.
    let r = post(&t, &mia, &gid, json!({ "body": "x", "parentId": 5 })).await;
    assert_validation(&r, "parentId must be a string or null");

    // Owner and admin are exempt.
    created(&top(&t, &owner, &gid).await);
    created(&reply(&t, &owner, &gid, &root).await);
    created(&top(&t, &boss, &gid).await);
    created(&reply(&t, &boss, &gid, &root).await);

    // Hearts, reports and deletes still work.
    let r = t
        .send(
            Method::PUT,
            &format!("/api/comments/{root}/heart"),
            Some(&noah),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(&noah),
            json!({ "targetType": "comment", "targetId": root, "reason": "spam" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/comments/{mine}"),
            Some(&noah),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    // Every remaining comment is listed.
    let v = list(&t, None, &gid).await;
    assert_eq!(v["total"], 3);
    assert_eq!(v["totalAll"], 6);
    assert_eq!(v["settings"]["mode"], "off");
    assert_eq!(v["settings"]["canManage"], false);
}

#[tokio::test]
async fn mode_replies_only() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let root = created(&top(&t, &mia, &gid).await);
    let locked = created(&top(&t, &mia, &gid).await);
    lock(&t, &owner, &locked).await;
    set(&t, &owner, &gid, "repliesOnly", 0).await;

    assert_validation(&top(&t, &mia, &gid).await, REPLIES_ONLY_MSG);
    created(&reply(&t, &mia, &gid, &root).await);
    assert_validation(
        &reply(&t, &mia, &gid, &locked).await,
        "This thread is locked",
    );
    // Unknown parent: 404 (a reply is allowed by the mode).
    let r = reply(&t, &mia, &gid, "no-such-comment").await;
    assert_message(&r, StatusCode::NOT_FOUND, "not_found", "Comment not found");
    created(&top(&t, &owner, &gid).await);
    created(&top(&t, &boss, &gid).await);
    created(&reply(&t, &owner, &gid, &locked).await);
}

// ---------------------------------------------------------------------------
// Slow mode
// ---------------------------------------------------------------------------

#[tokio::test]
async fn slow_mode_basic() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    set(&t, &owner, &gid, "on", 60).await;

    let root = created(&top(&t, &mia, &gid).await);
    let r = reply(&t, &mia, &gid, &root).await;
    assert_slow(&r, 60);
    let r = top(&t, &mia, &gid).await;
    assert_slow(&r, 60);
    assert_eq!(comment_count(&t, &gid).await, 1);

    let s = list(&t, Some(&mia), &gid).await["settings"].clone();
    let wait = s["waitSecs"].as_i64().unwrap();
    assert!((1..=60).contains(&wait), "waitSecs {wait}");
    assert_eq!(s["slowModeSecs"], 60);
    // Same value on every page.
    let p2 = t
        .get(&format!("/api/games/{gid}/comments?page=5"), Some(&mia))
        .await
        .json();
    assert!((1..=60).contains(&p2["settings"]["waitSecs"].as_i64().unwrap()));
    for tok in [None, Some(noah.as_str()), Some(owner.as_str())] {
        assert_eq!(list(&t, tok, &gid).await["settings"]["waitSecs"], 0);
    }
    // Another user is not affected.
    created(&reply(&t, &noah, &gid, &root).await);

    // Wait over → allowed again, and the wait restarts.
    backdate(&t, &gid, &mia_id, 61).await;
    assert_eq!(list(&t, Some(&mia), &gid).await["settings"]["waitSecs"], 0);
    created(&reply(&t, &mia, &gid, &root).await);
    assert_slow(&top(&t, &mia, &gid).await, 60);
    // Just inside the window: still waiting, Retry-After small.
    backdate(&t, &gid, &mia_id, 55).await;
    let n = assert_slow(&top(&t, &mia, &gid).await, 60);
    assert!(n <= 6, "Retry-After {n}");

    // Owner and admin are exempt.
    for tok in [&owner, &boss] {
        created(&top(&t, tok, &gid).await);
        created(&reply(&t, tok, &gid, &root).await);
    }
    assert_eq!(list(&t, Some(&boss), &gid).await["settings"]["waitSecs"], 0);
    // Slow mode is not a rate-limit bucket: all of the above ran with RATE_LIMIT off (the
    // test default).
}

#[tokio::test]
async fn slow_mode_edge_rules() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;

    // Posted while slow mode was off; turning it on applies at once.
    let first = created(&top(&t, &mia, &gid).await);
    set(&t, &owner, &gid, "on", 3600).await;
    assert_slow(&top(&t, &mia, &gid).await, 3600);
    // Back to 0 → the next post is allowed.
    set(&t, &owner, &gid, "on", 0).await;
    created(&top(&t, &mia, &gid).await);

    // Deleting your own comment does not reset the wait.
    set(&t, &owner, &gid, "on", 60).await;
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/comments/{first}"),
            Some(&mia),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_slow(&top(&t, &mia, &gid).await, 60);

    // A post rejected by the reply cap does not consume the slot.
    let full = created(&top(&t, &owner, &gid).await);
    bulk_replies(&t, &gid, &owner_id, &full, 200).await;
    assert_eq!(list(&t, Some(&noah), &gid).await["settings"]["waitSecs"], 0);
    assert_validation(
        &reply(&t, &noah, &gid, &full).await,
        "This thread has reached 200 replies",
    );
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM comment_post_times WHERE game_id = ? AND user_id = \
         (SELECT id FROM users WHERE username = 'noah')",
    )
    .bind(&gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(rows, 0, "a rejected first post must not create a row");
    // ... nor does a lock rejection.
    let locked = created(&top(&t, &owner, &gid).await);
    lock(&t, &owner, &locked).await;
    assert_validation(
        &reply(&t, &noah, &gid, &locked).await,
        "This thread is locked",
    );
    // ... nor a mode rejection.
    set(&t, &owner, &gid, "repliesOnly", 60).await;
    assert_validation(&top(&t, &noah, &gid).await, REPLIES_ONLY_MSG);
    set(&t, &owner, &gid, "on", 60).await;
    created(&top(&t, &noah, &gid).await);

    // A slow-mode rejection doesn't refresh the slot either: an existing row keeps its time.
    backdate(&t, &gid, &mia_id, 30).await;
    let before: String = sqlx::query_scalar(
        "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
    )
    .bind(&gid)
    .bind(&mia_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_slow(&top(&t, &mia, &gid).await, 60);
    let after: String = sqlx::query_scalar(
        "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
    )
    .bind(&gid)
    .bind(&mia_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(before, after);

    // A rejection on a reply with an existing row keeps the old time (cap after the claim).
    backdate(&t, &gid, &mia_id, 61).await;
    let before: String = sqlx::query_scalar(
        "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
    )
    .bind(&gid)
    .bind(&mia_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_validation(
        &reply(&t, &mia, &gid, &full).await,
        "This thread has reached 200 replies",
    );
    let after: String = sqlx::query_scalar(
        "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
    )
    .bind(&gid)
    .bind(&mia_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(before, after);
    created(&top(&t, &mia, &gid).await);

    // Every successful post records the time, with the comment's createdAt.
    let c = top(&t, &owner, &gid).await;
    assert_eq!(c.status, StatusCode::CREATED);
    let at: String = sqlx::query_scalar(
        "SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?",
    )
    .bind(&gid)
    .bind(&owner_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(c.json()["createdAt"], at.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_mode_concurrent_posts_one_success() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    set(&t, &owner, &gid, "on", 60).await;
    let root = created(&top(&t, &owner, &gid).await);

    let (a, b) = tokio::join!(top(&t, &mia, &gid), reply(&t, &mia, &gid, &root));
    let statuses = [a.status, b.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        1,
        "{} / {}",
        a.text(),
        b.text()
    );
    let loser = if a.status == StatusCode::CREATED {
        &b
    } else {
        &a
    };
    assert_slow(loser, 60);
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM comments c JOIN users u ON u.id = c.user_id \
         WHERE c.game_id = ? AND u.username = 'mia'",
    )
    .bind(&gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(n, 1);
}

// ---------------------------------------------------------------------------
// Validation order
// ---------------------------------------------------------------------------

#[tokio::test]
async fn validation_order_mode_lock_slow_cap() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let locked = created(&top(&t, &owner, &gid).await);
    lock(&t, &owner, &locked).await;
    let full = created(&top(&t, &owner, &gid).await);
    bulk_replies(&t, &gid, &owner_id, &full, 200).await;
    set(&t, &owner, &gid, "on", 60).await;
    // Mia posts, so she is waiting from here on.
    created(&top(&t, &mia, &gid).await);

    // off + slow waiting + locked → the mode message.
    set(&t, &owner, &gid, "off", 60).await;
    assert_validation(&reply(&t, &mia, &gid, &locked).await, OFF_MSG);
    // repliesOnly + locked + slow waiting → the lock message.
    set(&t, &owner, &gid, "repliesOnly", 60).await;
    assert_validation(
        &reply(&t, &mia, &gid, &locked).await,
        "This thread is locked",
    );
    // repliesOnly + top-level + slow waiting → the mode message.
    assert_validation(&top(&t, &mia, &gid).await, REPLIES_ONLY_MSG);
    // on + slow waiting + capped thread → slow mode.
    set(&t, &owner, &gid, "on", 60).await;
    assert_slow(&reply(&t, &mia, &gid, &full).await, 60);
    // Unknown parent while waiting: 404 (parent before slow mode).
    let r = reply(&t, &mia, &gid, "no-such-comment").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Game delete cascade
// ---------------------------------------------------------------------------

#[tokio::test]
async fn deleting_game_removes_post_times() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let other = game(&t, &owner, true).await;
    created(&top(&t, &mia, &gid).await);
    created(&top(&t, &owner, &gid).await);
    created(&top(&t, &mia, &other).await);
    let count = |g: String| {
        let db = t.state.db.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM comment_post_times WHERE game_id = ?",
            )
            .bind(g)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(count(gid.clone()).await, 2);
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{gid}"),
            Some(&owner),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert_eq!(count(gid.clone()).await, 0);
    assert_eq!(count(other.clone()).await, 1);
}

// ---------------------------------------------------------------------------
// Migration upgrade (0020 → 0021)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0020() {
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
                .filter(|x| x.version <= 20)
                .cloned()
                .collect(),
        );
        m.run(&db).await.unwrap();
        let ts = "2026-01-01T00:00:00.000Z";
        for sql in [
            format!(
                "INSERT INTO users (id, username, username_lower, email, email_lower, \
                 password_hash, display_name, created_at, role) VALUES \
                 ('u1', 'Una', 'una', 'u1@x', 'u1@x', 'h', 'Una', '{ts}', 'user'), \
                 ('u2', 'Ben', 'ben', 'u2@x', 'u2@x', 'h', 'Ben', '{ts}', 'user'), \
                 ('u3', 'Cy', 'cy', 'u3@x', 'u3@x', 'h', 'Cy', '{ts}', 'user')"
            ),
            format!(
                "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, \
                 updated_at, actions_json, controls_hint, published) VALUES \
                 ('g1', 'u1', 'Old', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '', 1), \
                 ('g2', 'u1', 'Older', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '', 1), \
                 ('g3', 'u1', 'Quiet', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '', 1)"
            ),
            "INSERT INTO comments (id, game_id, user_id, body, created_at) VALUES \
             ('c1', 'g1', 'u2', 'first', '2026-01-02T00:00:00.000Z'), \
             ('c2', 'g1', 'u3', 'second', '2026-01-03T00:00:00.000Z'), \
             ('c3', 'g2', 'u2', 'other game', '2026-01-06T00:00:00.000Z')"
                .to_string(),
            "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) VALUES \
             ('r1', 'g1', 'u2', 'reply', '2026-01-05T00:00:00.000Z', 'c1'), \
             ('r2', 'g1', 'u3', 'reply', '2026-01-04T00:00:00.000Z', 'c1')"
                .to_string(),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        db.close().await;
    }

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let t = TestApp {
        router: webgame_server::app(state.clone()),
        state,
        dir,
        clock: webgame_server::ratelimit::ManualClock::new(),
    };
    let modes: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id, comment_mode, comment_slow_mode_secs FROM games ORDER BY id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(
        modes,
        vec![
            ("g1".to_string(), "on".to_string(), 0),
            ("g2".to_string(), "on".to_string(), 0),
            ("g3".to_string(), "on".to_string(), 0),
        ]
    );
    for g in ["g1", "g2", "g3"] {
        assert_eq!(
            list(&t, None, g).await["settings"],
            json!({ "mode": "on", "slowModeSecs": 0, "canManage": false, "waitSecs": 0 })
        );
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT game_id, user_id, last_posted_at FROM comment_post_times \
         ORDER BY game_id, user_id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "g1".to_string(),
                "u2".to_string(),
                "2026-01-05T00:00:00.000Z".to_string()
            ),
            (
                "g1".to_string(),
                "u3".to_string(),
                "2026-01-04T00:00:00.000Z".to_string()
            ),
            (
                "g2".to_string(),
                "u2".to_string(),
                "2026-01-06T00:00:00.000Z".to_string()
            ),
        ]
    );
}

// ---------------------------------------------------------------------------
// Lenient reads of unknown stored values
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unknown_stored_values_read_as_defaults() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    sqlx::query(
        "UPDATE games SET comment_mode = 'followersOnly', comment_slow_mode_secs = 45 \
         WHERE id = ?",
    )
    .bind(&gid)
    .execute(&t.state.db)
    .await
    .unwrap();
    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(
        g["commentSettings"],
        json!({ "mode": "on", "slowModeSecs": 0 })
    );
    assert_eq!(
        list(&t, Some(&mia), &gid).await["settings"],
        json!({ "mode": "on", "slowModeSecs": 0, "canManage": false, "waitSecs": 0 })
    );
    created(&top(&t, &mia, &gid).await);
    created(&top(&t, &mia, &gid).await);
}
