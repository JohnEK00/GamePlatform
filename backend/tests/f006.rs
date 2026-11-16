//! F006: comment replies (one level), hearts, creator tag, permalinks, delete cascade and
//! moderation, rate limits and the 0012 migration.

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

async fn heart(t: &TestApp, method: Method, tok: Option<&str>, cid: &str) -> Resp {
    t.send(
        method,
        &format!("/api/comments/{cid}/heart"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn delete(t: &TestApp, tok: Option<&str>, cid: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/comments/{cid}"),
        tok,
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

async fn report_state(t: &TestApp, rid: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT status, resolution FROM reports WHERE id = ?")
        .bind(rid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn count(t: &TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

fn resolved_delete() -> (String, Option<String>) {
    ("resolved".into(), Some("delete".into()))
}

// ---------------------------------------------------------------------------
// Reply creation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reply_create_normalises_and_sets_reply_to() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;
    let other = game(&t, &owner, true).await;

    let root = comment(&t, &mia, &gid, "Is there a way to skip the intro?", None).await;
    assert_eq!(root["parentId"], Value::Null);
    assert_eq!(root["replyTo"], Value::Null);
    let root_id = id(&root);

    // Reply to a top-level comment.
    let r1 = comment(&t, &noah, &gid, "Press Esc twice", Some(&root_id)).await;
    assert_eq!(r1["parentId"], root_id.as_str());
    assert_eq!(r1["replyTo"], Value::Null);
    assert_eq!(r1["author"]["username"], "noah");
    assert_eq!(r1["hearts"], 0);
    assert_eq!(r1["myHeart"], false);
    assert_eq!(r1["canDelete"], true);
    assert_eq!(r1["isCreator"], false);

    // Reply to someone else's reply: stored under the root, replyTo = that author.
    let r2 = comment(&t, &mia, &gid, "Thanks!", Some(&id(&r1))).await;
    assert_eq!(r2["parentId"], root_id.as_str());
    assert_eq!(r2["replyTo"]["username"], "noah");

    // Reply to your own reply: no replyTo.
    let r3 = comment(&t, &mia, &gid, "Works now", Some(&id(&r2))).await;
    assert_eq!(r3["parentId"], root_id.as_str());
    assert_eq!(r3["replyTo"], Value::Null);

    // JSON null parentId = top-level.
    let top = post(&t, &noah, &gid, json!({ "body": "hi", "parentId": null })).await;
    assert_eq!(top.status, StatusCode::CREATED);
    assert_eq!(top.json()["parentId"], Value::Null);

    // Parent on another game → 404; unknown → 404.
    let r = post(
        &t,
        &noah,
        &other,
        json!({ "body": "x", "parentId": root_id }),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
    let r = post(&t, &noah, &gid, json!({ "body": "x", "parentId": "nope" })).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // Wrong type → 422.
    let r = post(&t, &noah, &gid, json!({ "body": "x", "parentId": 42 })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    // Body rule still applies to replies.
    let r = post(
        &t,
        &noah,
        &gid,
        json!({ "body": "  ", "parentId": root_id }),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Anonymous → 401.
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            None,
            json!({ "body": "x", "parentId": root_id }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Unpublished game, stranger → 404; the owner can reply there.
    let hidden = game(&t, &owner, false).await;
    let own = comment(&t, &owner, &hidden, "note to self", None).await;
    let r = post(
        &t,
        &noah,
        &hidden,
        json!({ "body": "x", "parentId": id(&own) }),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let rep = comment(&t, &owner, &hidden, "reply", Some(&id(&own))).await;
    assert_eq!(rep["parentId"], id(&own).as_str());
    assert_eq!(rep["isCreator"], true);
}

#[tokio::test]
async fn reply_cap_is_200() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    for i in 0..199 {
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
    // The 200th is allowed (also via a reply id, normalised to the root).
    comment(&t, &mia, &gid, "200th", Some("bulk-5")).await;
    let r = post(&t, &mia, &gid, json!({ "body": "201st", "parentId": root })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    assert_eq!(
        r.json()["error"]["message"],
        "This thread has reached 200 replies"
    );
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM comments WHERE parent_id = ?",
            &root
        )
        .await,
        200
    );
    // Top-level comments are unaffected.
    comment(&t, &mia, &gid, "new thread", None).await;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_threads_previews_and_counts() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;

    let a = id(&comment(&t, &mia, &gid, "A", None).await);
    let mut a_replies = Vec::new();
    for i in 0..5 {
        a_replies.push(id(
            &comment(&t, &noah, &gid, &format!("a{i}"), Some(&a)).await
        ));
    }
    let b = id(&comment(&t, &noah, &gid, "B", None).await);
    let b1 = id(&comment(&t, &mia, &gid, "b1", Some(&b)).await);
    let c = id(&comment(&t, &mia, &gid, "C", None).await);

    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["total"], 3);
    assert_eq!(v["totalAll"], 9);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 20);
    // Threads newest first.
    assert_eq!(ids(&v["items"]), vec![c.clone(), b.clone(), a.clone()]);
    let items = v["items"].as_array().unwrap();
    assert_eq!(items[0]["replyCount"], 0);
    assert_eq!(items[0]["replies"], json!([]));
    assert_eq!(items[1]["replyCount"], 1);
    assert_eq!(ids(&items[1]["replies"]), vec![b1]);
    // ≤ 3 oldest replies, oldest first.
    assert_eq!(items[2]["replyCount"], 5);
    assert_eq!(ids(&items[2]["replies"]), a_replies[..3].to_vec());
    assert_eq!(items[2]["replies"][0]["parentId"], a.as_str());
    // Every comment carries the F006 fields.
    for f in [
        "parentId",
        "replyTo",
        "isCreator",
        "hearts",
        "myHeart",
        "creatorHeart",
        "canDelete",
    ] {
        assert!(items[2].get(f).is_some(), "{f}");
        assert!(items[2]["replies"][0].get(f).is_some(), "{f}");
    }

    // Paging over threads only.
    let v = list(&t, None, &gid, "?perPage=2&page=2").await;
    assert_eq!(ids(&v["items"]), vec![a.clone()]);
    assert_eq!(v["total"], 3);
    assert_eq!(
        t.get(&format!("/api/games/{gid}/comments?page=x"), None)
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // Stats keep counting all rows, replies included.
    let s = t
        .get(&format!("/api/games/{gid}/stats"), Some(&owner))
        .await
        .json();
    assert_eq!(s["comments"], 9);
    let s = t.get("/api/users/me/stats", Some(&owner)).await.json();
    assert_eq!(s["totals"]["comments"], 9);
}

#[tokio::test]
async fn replies_endpoint_pages_oldest_first() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let mut replies = Vec::new();
    for i in 0..7 {
        replies.push(id(&comment(
            &t,
            &owner,
            &gid,
            &format!("r{i}"),
            Some(&root),
        )
        .await));
    }
    let r = t
        .get(&format!("/api/comments/{root}/replies?perPage=3"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["total"], 7);
    assert_eq!(v["perPage"], 3);
    assert_eq!(ids(&v["items"]), replies[..3].to_vec());
    let v = t
        .get(
            &format!("/api/comments/{root}/replies?perPage=3&page=3"),
            None,
        )
        .await
        .json();
    assert_eq!(ids(&v["items"]), replies[6..].to_vec());
    let v = t
        .get(&format!("/api/comments/{root}/replies"), None)
        .await
        .json();
    assert_eq!(v["perPage"], 50);
    assert_eq!(ids(&v["items"]), replies);
    assert_eq!(v["items"][0]["isCreator"], true);

    let r = t
        .get(&format!("/api/comments/{}/replies", replies[0]), None)
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    let r = t.get("/api/comments/nope/replies", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .get(&format!("/api/comments/{root}/replies?page=x"), None)
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_comment_context_and_visibility() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let mut replies = Vec::new();
    for i in 0..4 {
        replies.push(id(
            &comment(&t, &noah, &gid, &format!("r{i}"), Some(&root)).await
        ));
    }

    let r = t.get(&format!("/api/comments/{root}"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["comment"]["id"], root.as_str());
    assert_eq!(v["thread"]["id"], root.as_str());
    assert_eq!(v["thread"]["replyCount"], 4);
    assert_eq!(ids(&v["thread"]["replies"]), replies[..3].to_vec());

    let r = t.get(&format!("/api/comments/{}", replies[3]), None).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["comment"]["id"], replies[3].as_str());
    assert_eq!(v["comment"]["parentId"], root.as_str());
    assert_eq!(v["thread"]["id"], root.as_str());
    assert_eq!(v["thread"]["replyCount"], 4);

    assert_eq!(
        t.get("/api/comments/nope", None).await.status,
        StatusCode::NOT_FOUND
    );

    // Unpublished game: strangers get 404, the owner 200.
    let hidden = game(&t, &owner, false).await;
    let h = id(&comment(&t, &owner, &hidden, "secret", None).await);
    let hr = id(&comment(&t, &owner, &hidden, "secret reply", Some(&h)).await);
    for cid in [&h, &hr] {
        for tok in [None, Some(noah.as_str())] {
            let r = t.get(&format!("/api/comments/{cid}"), tok).await;
            assert_eq!(r.status, StatusCode::NOT_FOUND);
        }
        let r = t.get(&format!("/api/comments/{cid}"), Some(&owner)).await;
        assert_eq!(r.status, StatusCode::OK);
    }
    assert_eq!(
        t.get(&format!("/api/comments/{h}/replies"), Some(&noah))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get(&format!("/api/comments/{h}/replies"), Some(&owner))
            .await
            .status,
        StatusCode::OK
    );
}

// ---------------------------------------------------------------------------
// Hearts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hearts_toggle_idempotent_and_creator_heart() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;
    let cid = id(&comment(&t, &mia, &gid, "tip", None).await);

    for _ in 0..2 {
        let r = heart(&t, Method::PUT, Some(&noah), &cid).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(
            r.json(),
            json!({ "hearted": true, "hearts": 1, "creatorHeart": false })
        );
    }
    // myHeart only for that viewer.
    let v = list(&t, Some(&noah), &gid, "").await;
    assert_eq!(v["items"][0]["hearts"], 1);
    assert_eq!(v["items"][0]["myHeart"], true);
    let v = list(&t, Some(&owner), &gid, "").await;
    assert_eq!(v["items"][0]["myHeart"], false);
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["items"][0]["myHeart"], false);
    assert_eq!(v["items"][0]["hearts"], 1);

    // Owner heart → creatorHeart.
    let r = heart(&t, Method::PUT, Some(&owner), &cid).await;
    assert_eq!(
        r.json(),
        json!({ "hearted": true, "hearts": 2, "creatorHeart": true })
    );
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["items"][0]["creatorHeart"], true);
    assert_eq!(v["items"][0]["hearts"], 2);

    for _ in 0..2 {
        let r = heart(&t, Method::DELETE, Some(&noah), &cid).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(
            r.json(),
            json!({ "hearted": false, "hearts": 1, "creatorHeart": true })
        );
    }
    let r = heart(&t, Method::DELETE, Some(&owner), &cid).await;
    assert_eq!(
        r.json(),
        json!({ "hearted": false, "hearts": 0, "creatorHeart": false })
    );

    // Own comment: PUT 422, DELETE fine.
    let r = heart(&t, Method::PUT, Some(&mia), &cid).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    let r = heart(&t, Method::DELETE, Some(&mia), &cid).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["hearted"], false);

    // Anonymous 401, unknown 404.
    assert_eq!(
        heart(&t, Method::PUT, None, &cid).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        heart(&t, Method::DELETE, None, &cid).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        heart(&t, Method::PUT, Some(&noah), "nope").await.status,
        StatusCode::NOT_FOUND
    );

    // Hearts on replies; hidden game → 404 for strangers.
    let rep = id(&comment(&t, &noah, &gid, "reply", Some(&cid)).await);
    let r = heart(&t, Method::PUT, Some(&owner), &rep).await;
    assert_eq!(r.json()["creatorHeart"], true);
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["items"][0]["replies"][0]["creatorHeart"], true);
    let hidden = game(&t, &owner, false).await;
    let hc = id(&comment(&t, &owner, &hidden, "x", None).await);
    assert_eq!(
        heart(&t, Method::PUT, Some(&noah), &hc).await.status,
        StatusCode::NOT_FOUND
    );

    // Deleting the comment removes its hearts (and its replies' hearts).
    heart(&t, Method::PUT, Some(&noah), &cid).await;
    assert_eq!(
        delete(&t, Some(&mia), &cid).await.status,
        StatusCode::NO_CONTENT
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comment_hearts")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------------------
// Creator tag and permissions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn is_creator_and_can_delete() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let c1 = id(&comment(&t, &mia, &gid, "question", None).await);
    let oc = comment(&t, &owner, &gid, "creator note", None).await;
    assert_eq!(oc["isCreator"], true);
    let or = comment(&t, &owner, &gid, "Fixed in v4", Some(&c1)).await;
    assert_eq!(or["isCreator"], true);

    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["items"][0]["isCreator"], true);
    assert_eq!(v["items"][1]["isCreator"], false);
    assert_eq!(v["items"][1]["replies"][0]["isCreator"], true);

    // canDelete on mia's thread (and the owner's reply in it).
    for (tok, root, reply) in [
        (Some(mia.as_str()), true, false),
        (Some(owner.as_str()), true, true),
        (Some(boss.as_str()), true, true),
        (Some(noah.as_str()), false, false),
        (None, false, false),
    ] {
        let v = list(&t, tok, &gid, "").await;
        assert_eq!(v["items"][1]["canDelete"], root, "{tok:?}");
        assert_eq!(v["items"][1]["replies"][0]["canDelete"], reply, "{tok:?}");
        let ctx = t.get(&format!("/api/comments/{c1}"), tok).await.json();
        assert_eq!(ctx["comment"]["canDelete"], root);
    }
}

// ---------------------------------------------------------------------------
// Delete cascade and moderation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_permissions_cascade_and_reports() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (zoe, _) = t.register("zoe").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;

    let root = id(&comment(&t, &mia, &gid, "abusive", None).await);
    let r1 = id(&comment(&t, &noah, &gid, "quoting abuse", Some(&root)).await);
    let r2 = id(&comment(&t, &zoe, &gid, "agree", Some(&root)).await);
    heart(&t, Method::PUT, Some(&zoe), &r1).await;
    heart(&t, Method::PUT, Some(&noah), &root).await;

    // Stranger 403, anonymous 401, unknown 404.
    assert_eq!(
        delete(&t, Some(&zoe), &root).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        delete(&t, None, &root).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        delete(&t, Some(&zoe), "nope").await.status,
        StatusCode::NOT_FOUND
    );

    // Reply delete leaves the thread; its report is resolved.
    let rep_r2 = report(&t, &noah, &r2).await;
    assert_eq!(
        delete(&t, Some(&zoe), &r2).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(report_state(&t, &rep_r2).await, resolved_delete());
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["total"], 1);
    assert_eq!(v["totalAll"], 2);
    assert_eq!(v["items"][0]["replyCount"], 1);

    // Reports on the root and on its reply, plus one on an unrelated comment.
    let other = id(&comment(&t, &zoe, &gid, "unrelated", None).await);
    let rep_root = report(&t, &zoe, &root).await;
    let rep_r1 = report(&t, &zoe, &r1).await;
    let rep_other = report(&t, &noah, &other).await;

    // Admin can delete someone else's comment; replies and hearts cascade.
    assert_eq!(
        delete(&t, Some(&boss), &root).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM comments WHERE id = ?1 OR parent_id = ?1",
            &root
        )
        .await,
        0
    );
    let hearts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comment_hearts")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(hearts, 0);
    assert_eq!(report_state(&t, &rep_root).await, resolved_delete());
    assert_eq!(report_state(&t, &rep_r1).await, resolved_delete());
    assert_eq!(report_state(&t, &rep_other).await, ("open".into(), None));
    let v = list(&t, None, &gid, "").await;
    assert_eq!(ids(&v["items"]), vec![other.clone()]);
    assert_eq!(v["totalAll"], 1);
    assert_eq!(
        t.get(&format!("/api/comments/{r1}"), None).await.status,
        StatusCode::NOT_FOUND
    );

    // The game owner can delete too.
    assert_eq!(
        delete(&t, Some(&owner), &other).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(report_state(&t, &rep_other).await, resolved_delete());
}

#[tokio::test]
async fn admin_resolve_delete_cascades() {
    let t = admin_app().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let r1 = id(&comment(&t, &noah, &gid, "r1", Some(&root)).await);
    let r2 = id(&comment(&t, &owner, &gid, "r2", Some(&root)).await);

    // A report on a reply: created with the reply's game and preview.
    let rep_r1 = report(&t, &mia, &r1).await;
    let v = t.get("/api/admin/reports", Some(&boss)).await.json();
    let item = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == rep_r1.as_str())
        .unwrap()
        .clone();
    assert_eq!(item["targetGameId"], gid.as_str());
    assert_eq!(item["targetPreview"], "r1");

    // Resolve delete on a reply removes only the reply.
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rep_r1}/resolve"),
            Some(&boss),
            json!({ "action": "delete" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["resolution"], "delete");
    let v = list(&t, None, &gid, "").await;
    assert_eq!(v["items"][0]["replyCount"], 1);
    assert_eq!(ids(&v["items"][0]["replies"]), vec![r2.clone()]);

    // Resolve delete on the root: replies cascade, their open reports resolve too.
    let rep_r2 = report(&t, &mia, &r2).await;
    let rep_root = report(&t, &noah, &root).await;
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rep_root}/resolve"),
            Some(&boss),
            json!({ "action": "delete" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["status"], "resolved");
    assert_eq!(report_state(&t, &rep_r2).await, resolved_delete());
    assert_eq!(
        count(&t, "SELECT COUNT(*) FROM comments WHERE game_id = ?", &gid).await,
        0
    );
}

// ---------------------------------------------------------------------------
// Rate limits (ManualClock)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rate_limits_comments_and_hearts() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &owner, &gid, "root", None).await);

    // Comments and replies share the 30 / 10 min bucket.
    for i in 0..30 {
        let parent = (i % 2 == 0).then_some(root.as_str());
        comment(&t, &mia, &gid, &format!("c{i}"), parent).await;
    }
    let r = post(&t, &mia, &gid, json!({ "body": "31st", "parentId": root })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert_eq!(r.header("retry-after"), "20");
    t.clock.advance(Duration::from_secs(20));
    comment(&t, &mia, &gid, "after wait", Some(&root)).await;

    // Hearts: 120 / 10 min, PUT and DELETE shared.
    let (zoe, _) = t.register("zoe").await;
    let target = id(&comment(&t, &zoe, &gid, "heart me", None).await);
    for i in 0..120 {
        let m = if i % 2 == 0 {
            Method::PUT
        } else {
            Method::DELETE
        };
        let r = heart(&t, m, Some(&owner), &target).await;
        assert_eq!(r.status, StatusCode::OK, "heart #{i}: {}", r.text());
    }
    let r = heart(&t, Method::PUT, Some(&owner), &target).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert_eq!(r.header("retry-after"), "5");
    // Hearts don't consume the comment bucket (owner has used 1 of 30 comments).
    comment(&t, &owner, &gid, "still allowed", Some(&target)).await;
    t.clock.advance(Duration::from_secs(5));
    let r = heart(&t, Method::PUT, Some(&owner), &target).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["hearted"], true);
    // Another user has their own heart bucket.
    let r = heart(&t, Method::PUT, Some(&mia), &root).await;
    assert_eq!(r.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// User deletion
// ---------------------------------------------------------------------------

#[tokio::test]
async fn deleted_user_replies_vanish_and_reply_to_clears() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, noah_id) = t.register("noah").await;
    let gid = game(&t, &owner, true).await;
    let root = id(&comment(&t, &mia, &gid, "root", None).await);
    let n1 = id(&comment(&t, &noah, &gid, "noah reply", Some(&root)).await);
    let m1 = comment(&t, &mia, &gid, "answering noah", Some(&n1)).await;
    assert_eq!(m1["replyTo"]["username"], "noah");
    // noah's own thread, with a reply by mia: removed with noah.
    let nroot = id(&comment(&t, &noah, &gid, "noah thread", None).await);
    comment(&t, &mia, &gid, "reply in noah's thread", Some(&nroot)).await;
    heart(&t, Method::PUT, Some(&noah), &root).await;

    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&noah_id)
        .execute(&t.state.db)
        .await
        .unwrap();

    let v = list(&t, None, &gid, "").await;
    assert_eq!(ids(&v["items"]), vec![root.clone()]);
    assert_eq!(v["totalAll"], 2);
    let thread = &v["items"][0];
    assert_eq!(thread["hearts"], 0);
    assert_eq!(thread["replyCount"], 1);
    assert_eq!(thread["replies"][0]["id"], m1["id"]);
    assert_eq!(thread["replies"][0]["replyTo"], Value::Null);
}

// ---------------------------------------------------------------------------
// Migration upgrade (0011 → 0012)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_keeps_comments_as_threads() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let dir = tempfile::tempdir().unwrap();
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
                .filter(|x| x.version <= 11)
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
            "INSERT INTO reports (id, target_type, target_id, target_game_id, target_preview, \
             reason, reporter_id, created_at) VALUES \
             ('rp1', 'comment', 'c1', 'g1', 'first', 'spam', 'u1', '2026-01-04T00:00:00.000Z')",
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
    assert_eq!(v["total"], 2);
    assert_eq!(v["totalAll"], 2);
    assert_eq!(ids(&v["items"]), vec!["c2".to_string(), "c1".to_string()]);
    for item in v["items"].as_array().unwrap() {
        assert_eq!(item["parentId"], Value::Null);
        assert_eq!(item["replyCount"], 0);
        assert_eq!(item["replies"], json!([]));
        assert_eq!(item["hearts"], 0);
    }
    assert_eq!(v["items"][0]["isCreator"], true);

    // The old report still resolves through the cascade path.
    sqlx::query("DELETE FROM reports WHERE id <> 'rp1'")
        .execute(&t.state.db)
        .await
        .unwrap();
    let (rid,): (String,) = sqlx::query_as("SELECT id FROM reports")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(rid, "rp1");
    webgame_server::routes::comments::remove_comment(&t.state, "c1")
        .await
        .unwrap();
    let (status, resolution): (String, Option<String>) =
        sqlx::query_as("SELECT status, resolution FROM reports WHERE id = 'rp1'")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!((status, resolution), resolved_delete());
}
