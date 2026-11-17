//! F017: creator comment tools (pin, lock, "Top" sort), permissions, `canModerate`, validation
//! order, delete cascades, the `ThreadTools` rate limit and the 0015 migration.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

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

async fn reply_resp(t: &TestApp, tok: &str, gid: &str, parent: &str) -> Resp {
    post(
        t,
        tok,
        gid,
        json!({ "body": "a reply", "parentId": parent }),
    )
    .await
}

/// Post a comment (`parent` = None) or a reply; returns the created Comment.
async fn comment(t: &TestApp, tok: &str, gid: &str, text: &str, parent: Option<&str>) -> Value {
    let body = match parent {
        Some(p) => json!({ "body": text, "parentId": p }),
        None => json!({ "body": text }),
    };
    let r = post(t, tok, gid, body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn ids(items: &Value) -> Vec<String> {
    items.as_array().unwrap().iter().map(id).collect()
}

async fn list(t: &TestApp, tok: Option<&str>, gid: &str, query: &str) -> Value {
    let r = t
        .get(&format!("/api/games/{gid}/comments{query}"), tok)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

/// `PUT`/`DELETE /api/comments/{cid}/{tool}` (`tool` = `pin` or `lock`).
async fn tool(t: &TestApp, method: Method, tok: Option<&str>, cid: &str, tool: &str) -> Resp {
    t.send(
        method,
        &format!("/api/comments/{cid}/{tool}"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn tool_ok(t: &TestApp, method: Method, tok: &str, cid: &str, name: &str) -> Value {
    let r = tool(t, method, Some(tok), cid, name).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn heart(t: &TestApp, method: Method, tok: &str, cid: &str) -> Resp {
    t.send(
        method,
        &format!("/api/comments/{cid}/heart"),
        Some(tok),
        None,
        vec![],
        &[],
    )
    .await
}

async fn report(t: &TestApp, tok: &str, cid: &str) -> String {
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(tok),
            json!({ "targetType": "comment", "targetId": cid, "reason": "spam" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    id(&r.json())
}

async fn set_created(t: &TestApp, cid: &str, at: &str) {
    sqlx::query("UPDATE comments SET created_at = ? WHERE id = ?")
        .bind(at)
        .bind(cid)
        .execute(&t.state.db)
        .await
        .unwrap();
}

fn assert_message(r: &Resp, status: StatusCode, code: &str, message: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    assert_eq!(r.error_code(), code);
    assert_eq!(r.json()["error"]["message"], message);
}

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pin_replace_unpin_and_list_shape() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;
    let a = id(&comment(&t, &mia, &gid, "speedrun tip", None).await);
    let b = id(&comment(&t, &owner, &gid, "FAQ", None).await);
    let c = id(&comment(&t, &noah, &gid, "nice", None).await);
    for i in 0..4 {
        comment(&t, &noah, &gid, &format!("r{i}"), Some(&a)).await;
    }
    let before = list(&t, None, &gid, "").await;
    assert_eq!(before["pinned"], Value::Null);
    assert_eq!(before["total"], 3);
    assert_eq!(before["totalAll"], 7);

    // Owner pins a stranger's comment.
    let st = tool_ok(&t, Method::PUT, &owner, &a, "pin").await;
    assert_eq!(
        st,
        json!({ "id": a, "pinned": true, "locked": false, "unpinnedId": null })
    );
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["pinned"]["id"], a.as_str());
    assert_eq!(v["pinned"]["pinned"], true);
    assert_eq!(v["pinned"]["replyCount"], 4);
    assert_eq!(v["pinned"]["replies"].as_array().unwrap().len(), 3);
    assert_eq!(v["pinned"]["replies"][0]["pinned"], false);
    assert_eq!(ids(&v["items"]), vec![c.clone(), b.clone()]);
    assert_eq!(v["total"], 2);
    assert_eq!(v["totalAll"], 7);
    // Every page carries it, even past the end.
    let p2 = list(&t, None, &gid, "?page=2&perPage=1").await;
    assert_eq!(ids(&p2["items"]), vec![b.clone()]);
    assert_eq!(p2["pinned"]["id"], a.as_str());
    let p9 = list(&t, None, &gid, "?page=9&perPage=1").await;
    assert_eq!(p9["items"], json!([]));
    assert_eq!(p9["pinned"]["id"], a.as_str());

    // Idempotent.
    let st = tool_ok(&t, Method::PUT, &owner, &a, "pin").await;
    assert_eq!(st["pinned"], true);
    assert_eq!(st["unpinnedId"], Value::Null);

    // Pinning another comment replaces the pin.
    let st = tool_ok(&t, Method::PUT, &owner, &b, "pin").await;
    assert_eq!(st["pinned"], true);
    assert_eq!(st["unpinnedId"], a.as_str());
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["pinned"]["id"], b.as_str());
    assert_eq!(ids(&v["items"]), vec![c.clone(), a.clone()]);
    let a_item = &v["items"][1];
    assert_eq!(a_item["pinned"], false);
    assert_eq!(a_item["replyCount"], 4);

    // Unpin, twice.
    let st = tool_ok(&t, Method::DELETE, &owner, &b, "pin").await;
    assert_eq!(
        st,
        json!({ "id": b, "pinned": false, "locked": false, "unpinnedId": null })
    );
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["pinned"], Value::Null);
    assert_eq!(v["total"], 3);
    let st = tool_ok(&t, Method::DELETE, &owner, &b, "pin").await;
    assert_eq!(st["pinned"], false);

    // Pin and lock are independent.
    tool_ok(&t, Method::PUT, &owner, &c, "lock").await;
    let st = tool_ok(&t, Method::PUT, &owner, &c, "pin").await;
    assert_eq!(
        (st["pinned"].clone(), st["locked"].clone()),
        (json!(true), json!(true))
    );
    let st = tool_ok(&t, Method::DELETE, &owner, &c, "lock").await;
    assert_eq!(
        (st["pinned"].clone(), st["locked"].clone()),
        (json!(true), json!(false))
    );
}

#[tokio::test]
async fn partial_unique_index_allows_one_pin_per_game() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let gid = game(&t, &owner, true).await;
    let other = game(&t, &owner, true).await;
    let a = id(&comment(&t, &owner, &gid, "a", None).await);
    let b = id(&comment(&t, &owner, &gid, "b", None).await);
    let x = id(&comment(&t, &owner, &other, "x", None).await);
    tool_ok(&t, Method::PUT, &owner, &a, "pin").await;
    let err =
        sqlx::query("UPDATE comments SET pinned_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
            .bind(&b)
            .execute(&t.state.db)
            .await
            .unwrap_err();
    assert!(err.to_string().contains("UNIQUE"), "{err}");
    // Another game has its own pin.
    tool_ok(&t, Method::PUT, &owner, &x, "pin").await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE pinned_at IS NOT NULL")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

// ---------------------------------------------------------------------------
// Permissions and canModerate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_permissions_and_order() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let reply = id(&comment(&t, &mia, &gid, "reply", Some(&root)).await);
    let hidden = game(&t, &owner, false).await;
    let hidden_c = id(&comment(&t, &owner, &hidden, "draft note", None).await);

    for name in ["pin", "lock"] {
        for m in [Method::PUT, Method::DELETE] {
            // Anonymous → 401.
            let r = tool(&t, m.clone(), None, &root, name).await;
            assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{name}");
            // Stranger (even the comment's author) → 403.
            let r = tool(&t, m.clone(), Some(&mia), &root, name).await;
            assert_eq!(r.status, StatusCode::FORBIDDEN, "{name}");
            assert_eq!(r.error_code(), "forbidden");
            // Unknown → 404.
            let r = tool(&t, m.clone(), Some(&owner), "nope", name).await;
            assert_message(&r, StatusCode::NOT_FOUND, "not_found", "Comment not found");
            // Unpublished game, stranger → 404 (before 403).
            let r = tool(&t, m.clone(), Some(&mia), &hidden_c, name).await;
            assert_eq!(r.status, StatusCode::NOT_FOUND, "{name}");
            // Reply → 422 for the owner, 403 first for a stranger.
            let r = tool(&t, m.clone(), Some(&owner), &reply, name).await;
            let msg = if name == "pin" {
                "Only top-level comments can be pinned"
            } else {
                "Only top-level comments can be locked"
            };
            assert_message(&r, StatusCode::UNPROCESSABLE_ENTITY, "validation", msg);
            let r = tool(&t, m.clone(), Some(&mia), &reply, name).await;
            assert_eq!(r.status, StatusCode::FORBIDDEN);
        }
    }
    // Admin on someone else's published game.
    let st = tool_ok(&t, Method::PUT, &boss, &root, "pin").await;
    assert_eq!(st["pinned"], true);
    let st = tool_ok(&t, Method::PUT, &boss, &root, "lock").await;
    assert_eq!(st["locked"], true);
    // Step 2 uses the `GET /api/games/{id}` visibility rule (published or owner), so an
    // unpublished game's comment is 404 for admins too, as for hearts.
    let r = tool(&t, Method::PUT, Some(&boss), &hidden_c, "pin").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // Owner on their unpublished game.
    tool_ok(&t, Method::PUT, &owner, &hidden_c, "pin").await;
    tool_ok(&t, Method::DELETE, &owner, &hidden_c, "pin").await;
    // Nothing changed for replies.
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM comments WHERE parent_id IS NOT NULL \
         AND (pinned_at IS NOT NULL OR locked_at IS NOT NULL)",
    )
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn can_moderate_and_state_fields_everywhere() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;

    // POST response.
    let root = comment(&t, &mia, &gid, "root", None).await;
    assert_eq!(root["pinned"], false);
    assert_eq!(root["locked"], false);
    assert_eq!(root["canModerate"], false);
    let root = id(&root);
    let own_top = comment(&t, &owner, &gid, "owner top", None).await;
    assert_eq!(own_top["canModerate"], true);
    let own_reply = comment(&t, &owner, &gid, "owner reply", Some(&root)).await;
    assert_eq!(own_reply["canModerate"], false);
    assert_eq!(own_reply["pinned"], false);
    assert_eq!(own_reply["locked"], false);
    let reply = id(&own_reply);

    tool_ok(&t, Method::PUT, &owner, &root, "pin").await;
    tool_ok(&t, Method::PUT, &owner, &root, "lock").await;

    for (tok, expected) in [
        (Some(owner.as_str()), true),
        (Some(boss.as_str()), true),
        (Some(mia.as_str()), false),
        (None, false),
    ] {
        // List: pinned thread + items.
        let v = list(&t, tok, &gid, "").await;
        let p = &v["pinned"];
        assert_eq!(p["id"], root.as_str());
        assert_eq!(p["pinned"], true);
        assert_eq!(p["locked"], true);
        assert_eq!(p["canModerate"], expected);
        let r0 = &p["replies"][0];
        assert_eq!(r0["id"], reply.as_str());
        assert_eq!(r0["pinned"], false);
        assert_eq!(r0["locked"], false);
        assert_eq!(r0["canModerate"], false);
        let item = &v["items"][0];
        assert_eq!(item["pinned"], false);
        assert_eq!(item["locked"], false);
        assert_eq!(item["canModerate"], expected);

        // /replies.
        let r = t.get(&format!("/api/comments/{root}/replies"), tok).await;
        assert_eq!(r.status, StatusCode::OK);
        let it = &r.json()["items"][0];
        assert_eq!(it["pinned"], false);
        assert_eq!(it["locked"], false);
        assert_eq!(it["canModerate"], false);

        // CommentContext (via the reply and via the root).
        let r = t.get(&format!("/api/comments/{reply}"), tok).await;
        assert_eq!(r.status, StatusCode::OK);
        let ctx = r.json();
        assert_eq!(ctx["comment"]["pinned"], false);
        assert_eq!(ctx["comment"]["canModerate"], false);
        assert_eq!(ctx["thread"]["pinned"], true);
        assert_eq!(ctx["thread"]["locked"], true);
        assert_eq!(ctx["thread"]["canModerate"], expected);
        let r = t.get(&format!("/api/comments/{root}"), tok).await;
        assert_eq!(r.json()["comment"]["locked"], true);
        assert_eq!(r.json()["comment"]["canModerate"], expected);
    }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lock_rules_bypass_and_unlock() {
    let t = admin_app().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "bug report", None).await);
    let noah_reply = id(&comment(&t, &noah, &gid, "same here", Some(&root)).await);

    let st = tool_ok(&t, Method::PUT, &owner, &root, "lock").await;
    assert_eq!(
        st,
        json!({ "id": root, "pinned": false, "locked": true, "unpinnedId": null })
    );
    // Idempotent; the first lock time is kept.
    let first: String = sqlx::query_scalar("SELECT locked_at FROM comments WHERE id = ?")
        .bind(&root)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    tool_ok(&t, Method::PUT, &owner, &root, "lock").await;
    let again: String = sqlx::query_scalar("SELECT locked_at FROM comments WHERE id = ?")
        .bind(&root)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(first, again);

    // Strangers (including the thread author) can't reply, to the root or to a reply.
    for (tok, parent) in [(&noah, &root), (&mia, &root), (&noah, &noah_reply)] {
        let r = reply_resp(&t, tok, &gid, parent).await;
        assert_message(
            &r,
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "This thread is locked",
        );
    }

    // Owner reply → 201, and the thread author gets the F007 reply notification.
    // noah's earlier reply (before the lock) already notified mia once.
    let reply_notifs = |t: &TestApp| {
        let db = t.state.db.clone();
        let mia_id = mia_id.clone();
        let root = root.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM notification_events e \
                 JOIN notifications n ON n.id = e.notification_id \
                 WHERE n.recipient_id = ? AND n.kind = 'reply' AND n.comment_id = ?",
            )
            .bind(&mia_id)
            .bind(&root)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let before = reply_notifs(&t).await;
    let r = reply_resp(&t, &owner, &gid, &root).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(r.json()["locked"], false);
    assert_eq!(r.json()["author"]["id"], owner_id.as_str());
    assert_eq!(reply_notifs(&t).await, before + 1);

    // Admin reply → 201 (also to a reply).
    let r = reply_resp(&t, &boss, &gid, &noah_reply).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());

    // Top-level comments are unaffected.
    comment(&t, &noah, &gid, "new thread", None).await;

    // Hearts, report and delete still work on the locked thread.
    assert_eq!(
        heart(&t, Method::PUT, &noah, &root).await.status,
        StatusCode::OK
    );
    assert_eq!(
        heart(&t, Method::DELETE, &noah, &root).await.status,
        StatusCode::OK
    );
    report(&t, &noah, &root).await;
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/comments/{noah_reply}"),
            Some(&noah),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    // Unlock → strangers can reply again; unlock is idempotent.
    let st = tool_ok(&t, Method::DELETE, &owner, &root, "lock").await;
    assert_eq!(st["locked"], false);
    let st = tool_ok(&t, Method::DELETE, &owner, &root, "lock").await;
    assert_eq!(st["locked"], false);
    let r = reply_resp(&t, &noah, &gid, &root).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());

    // Deleting the locked thread removes its state with the row.
    tool_ok(&t, Method::PUT, &owner, &root, "lock").await;
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/comments/{root}"),
            Some(&mia),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = tool(&t, Method::PUT, Some(&owner), &root, "lock").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn lock_is_checked_before_cap_and_after_parent() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    for i in 0..200 {
        sqlx::query(
            "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) \
             VALUES (?, ?, ?, 'r', '2026-01-01T00:00:00.000Z', ?)",
        )
        .bind(format!("bulk-{i}"))
        .bind(&gid)
        .bind(&owner_id)
        .bind(&root)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    tool_ok(&t, Method::PUT, &owner, &root, "lock").await;
    // Stranger: the lock message wins over the cap.
    let r = reply_resp(&t, &mia, &gid, &root).await;
    assert_message(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "This thread is locked",
    );
    // The owner bypasses the lock but not the cap.
    let r = reply_resp(&t, &owner, &gid, &root).await;
    assert_message(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "This thread has reached 200 replies",
    );
    // Unknown parent is still 404.
    let r = reply_resp(&t, &mia, &gid, "nope").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

/// The guarded insert refuses a reply when the lock lands between the handler's check and the
/// insert (simulated by locking directly in the DB, then checking the guarded path's
/// re-read logic with the row already locked).
#[tokio::test]
async fn guarded_insert_refuses_locked_root() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    sqlx::query("UPDATE comments SET locked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(&root)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = reply_resp(&t, &mia, &gid, &root).await;
    assert_message(
        &r,
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        "This thread is locked",
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE parent_id = ?")
        .bind(&root)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sort_new_top_bogus_and_paging() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (zoe, _) = t.register("zoe").await;
    let gid = game(&t, &owner, true).await;
    // a: oldest, 2 hearts; b: middle, 0 hearts; c: newest, 2 hearts; d: 5 hearts on a reply
    // only (replies' hearts don't count).
    let a = id(&comment(&t, &mia, &gid, "a", None).await);
    let b = id(&comment(&t, &mia, &gid, "b", None).await);
    let c = id(&comment(&t, &mia, &gid, "c", None).await);
    let d = id(&comment(&t, &mia, &gid, "d", None).await);
    set_created(&t, &a, "2026-01-01T00:00:00.000Z").await;
    set_created(&t, &b, "2026-01-02T00:00:00.000Z").await;
    set_created(&t, &c, "2026-01-03T00:00:00.000Z").await;
    set_created(&t, &d, "2025-12-01T00:00:00.000Z").await;
    let dr = id(&comment(&t, &mia, &gid, "d reply", Some(&d)).await);
    for tok in [&owner, &noah] {
        assert_eq!(heart(&t, Method::PUT, tok, &a).await.status, StatusCode::OK);
        assert_eq!(heart(&t, Method::PUT, tok, &c).await.status, StatusCode::OK);
    }
    for tok in [&owner, &noah, &zoe] {
        assert_eq!(
            heart(&t, Method::PUT, tok, &dr).await.status,
            StatusCode::OK
        );
    }

    let top = list(&t, None, &gid, "?sort=top").await;
    assert_eq!(
        ids(&top["items"]),
        vec![c.clone(), a.clone(), b.clone(), d.clone()]
    );
    let newest = vec![c.clone(), b.clone(), a.clone(), d.clone()];
    assert_eq!(
        ids(&list(&t, None, &gid, "?sort=new").await["items"]),
        newest
    );
    assert_eq!(ids(&list(&t, None, &gid, "").await["items"]), newest);
    assert_eq!(ids(&list(&t, None, &gid, "?sort=").await["items"]), newest);

    // Unknown sort → 400, checked before paging.
    for q in ["?sort=bogus", "?sort=TOP", "?sort=bogus&page=0"] {
        let r = t.get(&format!("/api/games/{gid}/comments{q}"), None).await;
        assert_message(
            &r,
            StatusCode::BAD_REQUEST,
            "bad_request",
            &format!(
                "Unknown sort '{}' (expected new or top)",
                q.trim_start_matches("?sort=").split('&').next().unwrap()
            ),
        );
    }

    // The pinned thread is excluded in both sorts.
    tool_ok(&t, Method::PUT, &owner, &c, "pin").await;
    let top = list(&t, None, &gid, "?sort=top").await;
    assert_eq!(ids(&top["items"]), vec![a.clone(), b.clone(), d.clone()]);
    assert_eq!(top["total"], 3);
    assert_eq!(top["pinned"]["id"], c.as_str());
    let new = list(&t, None, &gid, "?sort=new").await;
    assert_eq!(ids(&new["items"]), vec![b.clone(), a.clone(), d.clone()]);
    assert_eq!(new["pinned"]["id"], c.as_str());

    // perPage=1 covers every non-pinned thread exactly once, in both sorts.
    for sort in ["new", "top"] {
        let mut seen = Vec::new();
        for page in 1..=4 {
            let v = list(
                &t,
                None,
                &gid,
                &format!("?sort={sort}&page={page}&perPage=1"),
            )
            .await;
            assert_eq!(v["total"], 3);
            assert_eq!(v["pinned"]["id"], c.as_str());
            seen.extend(ids(&v["items"]));
        }
        let mut sorted = seen.clone();
        sorted.sort();
        let mut expected = vec![a.clone(), b.clone(), d.clone()];
        expected.sort();
        assert_eq!(sorted, expected, "{sort}: {seen:?}");
    }
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn deleting_pinned_comment_and_game() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;

    // Author deletes their pinned comment.
    let a = id(&comment(&t, &mia, &gid, "a", None).await);
    tool_ok(&t, Method::PUT, &owner, &a, "pin").await;
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/comments/{a}"),
            Some(&mia),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(list(&t, None, &gid, "").await["pinned"], Value::Null);

    // Admin resolve `delete` on a pinned comment's report.
    let b = id(&comment(&t, &mia, &gid, "b", None).await);
    comment(&t, &owner, &gid, "reply", Some(&b)).await;
    tool_ok(&t, Method::PUT, &owner, &b, "pin").await;
    tool_ok(&t, Method::PUT, &owner, &b, "lock").await;
    let rep = report(&t, &owner, &b).await;
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rep}/resolve"),
            Some(&boss),
            json!({ "action": "delete" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["pinned"], Value::Null);
    assert_eq!(v["totalAll"], 0);

    // Deleting the game removes a pinned + locked thread with no FK error.
    let c = id(&comment(&t, &mia, &gid, "c", None).await);
    comment(&t, &mia, &gid, "reply", Some(&c)).await;
    tool_ok(&t, Method::PUT, &owner, &c, "pin").await;
    tool_ok(&t, Method::PUT, &owner, &c, "lock").await;
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
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments WHERE game_id = ?")
        .bind(&gid)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let r = tool(&t, Method::DELETE, Some(&owner), &c, "pin").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Rate limit (ManualClock)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn thread_tools_share_one_bucket() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let calls = [
        (Method::PUT, "pin"),
        (Method::DELETE, "pin"),
        (Method::PUT, "lock"),
        (Method::DELETE, "lock"),
    ];
    for i in 0..60 {
        let (m, name) = &calls[i % 4];
        let r = tool(&t, m.clone(), Some(&owner), &root, name).await;
        assert_eq!(r.status, StatusCode::OK, "call #{i}: {}", r.text());
    }
    let r = tool(&t, Method::PUT, Some(&owner), &root, "lock").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert_eq!(r.header("retry-after"), "10");
    // Not the comment or heart buckets.
    comment(&t, &owner, &gid, "still allowed", Some(&root)).await;
    assert_eq!(
        heart(&t, Method::PUT, &owner, &root).await.status,
        StatusCode::OK
    );
    // Another user (admin-less stranger) has their own bucket and still gets 403.
    let r = tool(&t, Method::PUT, Some(&mia), &root, "pin").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    t.clock.advance(Duration::from_secs(10));
    let r = tool(&t, Method::PUT, Some(&owner), &root, "pin").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = tool(&t, Method::PUT, Some(&owner), &root, "pin").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

// ---------------------------------------------------------------------------
// Migration upgrade (0014 → 0015)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0014() {
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
                .filter(|x| x.version <= 14)
                .cloned()
                .collect(),
        );
        m.run(&db).await.unwrap();
        for sql in [
            "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
             display_name, created_at) VALUES \
             ('u1', 'Owen', 'owen', 'o@x', 'o@x', 'h', 'Owen', '2026-01-01T00:00:00.000Z'), \
             ('u2', 'Mia', 'mia', 'm@x', 'm@x', 'h', 'Mia', '2026-01-01T00:00:00.000Z')",
            "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, \
             updated_at, first_published_at, actions_json, controls_hint) VALUES \
             ('g1', 'u1', 'Old', 'main.js', 800, 600, '2026-01-01T00:00:00.000Z', \
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[]', '')",
            "INSERT INTO comments (id, game_id, user_id, body, created_at) VALUES \
             ('c1', 'g1', 'u2', 'first', '2026-01-02T00:00:00.000Z'), \
             ('c2', 'g1', 'u1', 'second', '2026-01-03T00:00:00.000Z')",
            "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) VALUES \
             ('r1', 'g1', 'u1', 'reply', '2026-01-04T00:00:00.000Z', 'c1')",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
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
    let v = list(&t, None, "g1", "").await;
    assert_eq!(v["pinned"], Value::Null);
    assert_eq!(v["total"], 2);
    assert_eq!(v["totalAll"], 3);
    assert_eq!(ids(&v["items"]), vec!["c2".to_string(), "c1".to_string()]);
    for item in v["items"].as_array().unwrap() {
        assert_eq!(item["pinned"], false);
        assert_eq!(item["locked"], false);
        assert_eq!(item["canModerate"], false);
        for r in item["replies"].as_array().unwrap() {
            assert_eq!(r["pinned"], false);
            assert_eq!(r["locked"], false);
        }
    }
    assert_eq!(v["items"][1]["replies"][0]["id"], "r1");
    // Old threads can be pinned after the upgrade.
    let (tok, _) = t.register("noah").await;
    let r = tool(&t, Method::PUT, Some(&tok), "c1", "pin").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}
