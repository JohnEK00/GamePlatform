//! F007: in-app notifications (triggers, recipients, coalescing, dedupe, retraction, settings,
//! visibility, cascades, list / count / mark-read contracts, rate limit, fan-out, pruning and
//! the 0013 migration).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::*;
use serde_json::{Value, json};
use webgame_server::notifications::{prune, stamp};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Distinct millisecond timestamps between events whose order a test checks.
async fn tick() {
    tokio::time::sleep(Duration::from_millis(5)).await;
}

async fn game(t: &TestApp, owner: &str, title: &str, published: bool) -> String {
    let g = t.create_game(owner, title, "", published).await;
    g["id"].as_str().unwrap().to_string()
}

async fn comment(t: &TestApp, tok: &str, gid: &str, text: &str, parent: Option<&str>) -> String {
    let body = match parent {
        Some(p) => json!({ "body": text, "parentId": p }),
        None => json!({ "body": text }),
    };
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(tok),
            body,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

async fn send_empty(t: &TestApp, method: Method, uri: &str, tok: &str) -> Resp {
    t.send(method, uri, Some(tok), None, vec![], &[]).await
}

async fn heart(t: &TestApp, tok: &str, cid: &str) {
    let r = send_empty(t, Method::PUT, &format!("/api/comments/{cid}/heart"), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn unheart(t: &TestApp, tok: &str, cid: &str) {
    let r = send_empty(
        t,
        Method::DELETE,
        &format!("/api/comments/{cid}/heart"),
        tok,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn follow(t: &TestApp, tok: &str, username: &str) {
    let r = send_empty(
        t,
        Method::PUT,
        &format!("/api/users/{username}/follow"),
        tok,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn unfollow(t: &TestApp, tok: &str, username: &str) {
    let r = send_empty(
        t,
        Method::DELETE,
        &format!("/api/users/{username}/follow"),
        tok,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn patch_published(t: &TestApp, tok: &str, gid: &str, published: bool) {
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

/// `GET /api/notifications{query}` → the page JSON.
async fn page(t: &TestApp, tok: &str, query: &str) -> Value {
    let r = t
        .get(&format!("/api/notifications{query}"), Some(tok))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn items(t: &TestApp, tok: &str) -> Vec<Value> {
    page(t, tok, "?limit=50").await["items"]
        .as_array()
        .unwrap()
        .clone()
}

async fn unread(t: &TestApp, tok: &str) -> Value {
    let r = t.get("/api/notifications/unread-count", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn mark(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::POST, "/api/notifications/read", Some(tok), body)
        .await
}

fn usernames(actors: &Value) -> Vec<String> {
    actors
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["username"].as_str().unwrap().to_string())
        .collect()
}

async fn scalar(t: &TestApp, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Triggers and recipients
// ---------------------------------------------------------------------------

#[tokio::test]
async fn top_level_comment_notifies_owner_not_self() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;

    // The owner's own comment notifies nobody.
    comment(&t, &owner, &gid, "welcome", None).await;
    assert!(items(&t, &owner).await.is_empty());

    let cid = comment(&t, &mia, &gid, "Great game", None).await;
    let list = items(&t, &owner).await;
    assert_eq!(list.len(), 1);
    let n = &list[0];
    assert_eq!(n["kind"], "comment");
    assert_eq!(usernames(&n["actors"]), vec!["mia"]);
    assert_eq!(n["actors"][0]["id"], mia_id.as_str());
    assert_eq!(n["actorCount"], 1);
    assert_eq!(n["eventCount"], 1);
    assert_eq!(n["game"]["id"], gid.as_str());
    assert_eq!(n["game"]["title"], "Pixel Peaks");
    assert_eq!(n["game"]["thumbnailUrl"], Value::Null);
    assert_eq!(n["commentId"], cid.as_str());
    assert_eq!(n["excerpt"], "Great game");
    assert_eq!(n["ownsThread"], false);
    assert_eq!(n["creatorHeart"], false);
    assert_eq!(n["read"], false);
    assert_eq!(n["createdAt"], n["updatedAt"]);
    assert_eq!(n["path"], format!("/games/{gid}?comment={cid}"));
    assert!(n["id"].as_str().unwrap().parse::<i64>().unwrap() > 0);
    // The poster gets nothing.
    assert!(items(&t, &mia).await.is_empty());
}

#[tokio::test]
async fn replies_notify_root_author_and_reply_to_once_each() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let (cal, _) = t.register("cal").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let root = comment(&t, &ava, &gid, "How do I skip the intro?", None).await;
    let _ = items(&t, &owner).await; // owner has the `comment` item; not checked here

    // Ben answers the root: only Ava (the thread author).
    let r1 = comment(&t, &ben, &gid, "Press Esc twice", Some(&root)).await;
    let a = items(&t, &ava).await;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["kind"], "reply");
    assert_eq!(a[0]["ownsThread"], true);
    assert_eq!(a[0]["commentId"], r1.as_str());
    assert_eq!(a[0]["excerpt"], "Press Esc twice");
    assert_eq!(a[0]["path"], format!("/games/{gid}?comment={r1}"));
    assert!(items(&t, &ben).await.is_empty());

    // Cal answers Ben's reply: Ava (thread) and Ben (replyTo), once each; never Cal.
    tick().await;
    let r2 = comment(&t, &cal, &gid, "Or hold Space", Some(&r1)).await;
    let a = items(&t, &ava).await;
    assert_eq!(a.len(), 1, "joined the unread thread group");
    assert_eq!(a[0]["actorCount"], 2);
    assert_eq!(a[0]["eventCount"], 2);
    assert_eq!(usernames(&a[0]["actors"]), vec!["cal", "ben"]);
    assert_eq!(a[0]["commentId"], r2.as_str());
    let b = items(&t, &ben).await;
    assert_eq!(b.len(), 1);
    assert_eq!(b[0]["kind"], "reply");
    assert_eq!(b[0]["ownsThread"], false);
    assert_eq!(b[0]["commentId"], r2.as_str());
    assert!(items(&t, &cal).await.is_empty());
    // The owner only has the top-level comment item.
    let o = items(&t, &owner).await;
    assert_eq!(o.len(), 1);
    assert_eq!(o[0]["kind"], "comment");
}

#[tokio::test]
async fn root_author_who_is_also_reply_to_gets_one_notification() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let root = comment(&t, &ava, &gid, "root", None).await;
    // Ava replies in her own thread: nobody but... nobody (she is the poster).
    let own = comment(&t, &ava, &gid, "update", Some(&root)).await;
    assert!(items(&t, &ava).await.is_empty());
    // Ben answers Ava's reply: thread author = replyTo user = Ava → one event.
    comment(&t, &ben, &gid, "thanks", Some(&own)).await;
    let a = items(&t, &ava).await;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["eventCount"], 1);
    assert_eq!(a[0]["actorCount"], 1);
    assert_eq!(a[0]["ownsThread"], true);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events e JOIN notifications n ON n.id = e.notification_id WHERE n.kind = 'reply'").await,
        1
    );
}

#[tokio::test]
async fn hearts_notify_author_with_creator_heart() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let cid = comment(&t, &ava, &gid, "tip: jump twice", None).await;

    heart(&t, &ben, &cid).await;
    let a = items(&t, &ava).await;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["kind"], "heart");
    assert_eq!(a[0]["creatorHeart"], false);
    assert_eq!(a[0]["commentId"], cid.as_str());
    assert_eq!(a[0]["excerpt"], "tip: jump twice");
    assert_eq!(a[0]["path"], format!("/games/{gid}?comment={cid}"));
    assert_eq!(a[0]["ownsThread"], false);

    tick().await;
    heart(&t, &owner, &cid).await;
    let a = items(&t, &ava).await;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["actorCount"], 2);
    assert_eq!(a[0]["eventCount"], 2);
    assert_eq!(usernames(&a[0]["actors"]), vec!["owen", "ben"]);
    assert_eq!(a[0]["creatorHeart"], true);
    // The hearters get nothing.
    assert!(items(&t, &ben).await.is_empty());
}

#[tokio::test]
async fn follow_notifies_followee() {
    let t = setup().await;
    let (owner, _) = t.register("Owen").await;
    let (mia, _) = t.register("mia").await;
    follow(&t, &mia, "owen").await;
    let o = items(&t, &owner).await;
    assert_eq!(o.len(), 1);
    let n = &o[0];
    assert_eq!(n["kind"], "follow");
    assert_eq!(usernames(&n["actors"]), vec!["mia"]);
    assert_eq!(n["game"], Value::Null);
    assert_eq!(n["commentId"], Value::Null);
    assert_eq!(n["excerpt"], Value::Null);
    assert_eq!(n["path"], "/u/Owen/followers");
    assert!(items(&t, &mia).await.is_empty());
}

#[tokio::test]
async fn first_publish_notifies_each_follower_once() {
    let t = setup().await;
    let (owner, _) = t.register("rex").await;
    let (f1, _) = t.register("fay").await;
    let (f2, _) = t.register("gus").await;
    let (other, _) = t.register("hal").await;
    follow(&t, &f1, "rex").await;
    follow(&t, &f2, "rex").await;

    // Published at creation.
    let g1 = game(&t, &owner, "Lava Leap", true).await;
    for tok in [&f1, &f2] {
        let l = items(&t, tok).await;
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["kind"], "gamePublished");
        assert_eq!(usernames(&l[0]["actors"]), vec!["rex"]);
        assert_eq!(l[0]["game"]["id"], g1.as_str());
        assert_eq!(l[0]["game"]["title"], "Lava Leap");
        assert_eq!(l[0]["path"], format!("/games/{g1}"));
        assert_eq!(l[0]["commentId"], Value::Null);
        assert_eq!(l[0]["eventCount"], 1);
    }
    assert!(items(&t, &other).await.is_empty());

    // Created as a draft: nothing; PATCH false → true: one each.
    let g2 = game(&t, &owner, "Ice Hop", false).await;
    assert_eq!(items(&t, &f1).await.len(), 1);
    patch_published(&t, &owner, &g2, true).await;
    assert_eq!(items(&t, &f1).await.len(), 2);
    assert_eq!(items(&t, &f2).await.len(), 2);

    // Re-publishing never notifies again.
    patch_published(&t, &owner, &g2, false).await;
    patch_published(&t, &owner, &g2, true).await;
    assert_eq!(items(&t, &f1).await.len(), 2);
    assert_eq!(items(&t, &f2).await.len(), 2);
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE kind = 'gamePublished'"
        )
        .await,
        4
    );
    // The owner is never a recipient of their own publish.
    let o = items(&t, &owner).await;
    assert!(o.iter().all(|n| n["kind"] == "follow"));
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn comments_coalesce_while_unread() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    comment(&t, &ava, &gid, "a1", None).await;
    tick().await;
    comment(&t, &ava, &gid, "a2", None).await;
    tick().await;
    let b1 = comment(&t, &ben, &gid, "b1", None).await;

    let l = items(&t, &owner).await;
    assert_eq!(l.len(), 1);
    let n = &l[0];
    assert_eq!(n["actorCount"], 2);
    assert_eq!(n["eventCount"], 3);
    assert_eq!(usernames(&n["actors"]), vec!["ben", "ava"]);
    assert_eq!(n["commentId"], b1.as_str());
    assert_eq!(n["excerpt"], "b1");
    assert!(n["createdAt"].as_str().unwrap() < n["updatedAt"].as_str().unwrap());

    // Mark it read; it never changes again and the next comment opens a new group.
    let r = mark(
        &t,
        &owner,
        json!({ "ids": [n["id"]], "upTo": n["updatedAt"] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["unread"], 0);
    tick().await;
    let a3 = comment(&t, &ava, &gid, "a3", None).await;
    let l = items(&t, &owner).await;
    assert_eq!(l.len(), 2);
    assert_eq!(l[0]["read"], false);
    assert_eq!(l[0]["eventCount"], 1);
    assert_eq!(l[0]["commentId"], a3.as_str());
    assert_eq!(l[1]["id"], n["id"]);
    assert_eq!(l[1]["read"], true);
    assert_eq!(l[1]["eventCount"], 3);
    assert_eq!(l[1]["updatedAt"], n["updatedAt"]);
    assert_eq!(unread(&t, &owner).await["unread"], 1);
}

// ---------------------------------------------------------------------------
// Dedupe and retraction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn heart_dedupe_and_retraction() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let cid = comment(&t, &ava, &gid, "tip", None).await;

    heart(&t, &ben, &cid).await;
    assert_eq!(unread(&t, &ava).await["unread"], 1);
    unheart(&t, &ben, &cid).await;
    assert!(items(&t, &ava).await.is_empty(), "retracted while unread");
    let c = unread(&t, &ava).await;
    assert_eq!(c["unread"], 0);
    assert_eq!(c["latestAt"], Value::Null);

    for _ in 0..10 {
        heart(&t, &ben, &cid).await;
        unheart(&t, &ben, &cid).await;
    }
    heart(&t, &ben, &cid).await;
    let l = items(&t, &ava).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["actorCount"], 1);
    assert_eq!(l[0]["eventCount"], 1);

    // Once read, the same user's toggling adds nothing.
    let r = mark(&t, &ava, json!({ "upTo": l[0]["updatedAt"] })).await;
    assert_eq!(r.json()["unread"], 0);
    for _ in 0..3 {
        unheart(&t, &ben, &cid).await;
        heart(&t, &ben, &cid).await;
    }
    let l2 = items(&t, &ava).await;
    assert_eq!(l2.len(), 1);
    assert_eq!(l2[0]["read"], true);
    assert_eq!(l2[0]["actorCount"], 1);
    assert_eq!(unread(&t, &ava).await["unread"], 0);
}

#[tokio::test]
async fn follow_dedupe_and_retraction() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;

    follow(&t, &mia, "owen").await;
    unfollow(&t, &mia, "owen").await;
    assert!(items(&t, &owner).await.is_empty());
    assert_eq!(unread(&t, &owner).await["unread"], 0);

    for _ in 0..10 {
        follow(&t, &mia, "owen").await;
        unfollow(&t, &mia, "owen").await;
    }
    follow(&t, &mia, "owen").await;
    tick().await;
    follow(&t, &noah, "owen").await;
    let l = items(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["actorCount"], 2);
    assert_eq!(l[0]["eventCount"], 2);
    assert_eq!(usernames(&l[0]["actors"]), vec!["noah", "mia"]);

    mark(&t, &owner, json!({ "upTo": l[0]["updatedAt"] })).await;
    unfollow(&t, &mia, "owen").await;
    follow(&t, &mia, "owen").await;
    let l = items(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["read"], true);
    assert_eq!(l[0]["actorCount"], 2);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_defaults_partial_updates_and_validation() {
    let t = setup().await;
    let (ava, _) = t.register("ava").await;
    let all_on = json!({ "comments": true, "replies": true, "hearts": true, "follows": true, "newGames": true, "pins": true, "collections": true, "screenshots": true, "postReplies": true, "postHearts": true });
    let r = t.get("/api/notifications/settings", Some(&ava)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json(), all_on);

    let put = |body: Value| {
        let t = &t;
        let ava = ava.clone();
        async move {
            t.json(Method::PUT, "/api/notifications/settings", Some(&ava), body)
                .await
        }
    };
    let r = put(json!({ "hearts": false })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json(),
        json!({ "comments": true, "replies": true, "hearts": false, "follows": true, "newGames": true, "pins": true, "collections": true, "screenshots": true, "postReplies": true, "postHearts": true })
    );
    let r = put(json!({ "newGames": false, "unknown": 5 })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["hearts"], false, "earlier change kept");
    assert_eq!(r.json()["newGames"], false);
    let r = put(json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["newGames"], false);
    let r = put(json!({ "hearts": true })).await;
    assert_eq!(r.json()["hearts"], true);
    assert_eq!(r.json()["newGames"], false);

    for bad in [
        json!({ "hearts": "yes" }),
        json!({ "replies": 1 }),
        json!([true]),
    ] {
        let r = put(bad.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(r.error_code(), "validation");
    }
    let r = t
        .send(
            Method::PUT,
            "/api/notifications/settings",
            Some(&ava),
            Some("application/json"),
            b"{nope".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    // Unchanged after the failures.
    assert_eq!(
        t.get("/api/notifications/settings", Some(&ava))
            .await
            .json()["newGames"],
        false
    );
}

#[tokio::test]
async fn muted_kinds_are_not_written() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let (fan, _) = t.register("fan").await;
    let (quiet, _) = t.register("quiet").await;

    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&ava),
            json!({ "hearts": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let cid = comment(&t, &ava, &gid, "tip", None).await;
    heart(&t, &ben, &cid).await;
    assert!(items(&t, &ava).await.is_empty(), "hearts are off");
    // Other kinds still arrive.
    comment(&t, &ben, &gid, "answer", Some(&cid)).await;
    let l = items(&t, &ava).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["kind"], "reply");

    // newGames off excludes that follower from the fan-out.
    follow(&t, &fan, "owen").await;
    follow(&t, &quiet, "owen").await;
    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&quiet),
            json!({ "newGames": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    game(&t, &owner, "Lava Leap", true).await;
    assert_eq!(items(&t, &fan).await.len(), 1);
    assert!(items(&t, &quiet).await.is_empty());
}

// ---------------------------------------------------------------------------
// Visibility and cascades
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unpublished_games_hide_notifications_and_deleted_games_remove_them() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let cid = comment(&t, &ava, &gid, "tip", None).await;
    heart(&t, &ben, &cid).await;
    assert_eq!(items(&t, &ava).await.len(), 1);
    assert_eq!(unread(&t, &ava).await["unread"], 1);

    patch_published(&t, &owner, &gid, false).await;
    assert!(items(&t, &ava).await.is_empty());
    assert_eq!(unread(&t, &ava).await["unread"], 0);
    // The owner still sees their own (unpublished) game's notifications.
    assert_eq!(items(&t, &owner).await.len(), 1);

    patch_published(&t, &owner, &gid, true).await;
    assert_eq!(items(&t, &ava).await.len(), 1);
    assert_eq!(unread(&t, &ava).await["unread"], 1);

    let r = send_empty(&t, Method::DELETE, &format!("/api/games/{gid}"), &owner).await;
    assert!(r.status.is_success(), "{}", r.text());
    assert!(items(&t, &ava).await.is_empty());
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 0);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events").await,
        0
    );
}

#[tokio::test]
async fn comment_deletes_remove_their_notifications() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let (boss, _) = t.register("boss").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;

    // Heart group: deleting the hearted comment (by its author) removes it.
    let hearted = comment(&t, &ava, &gid, "tip", None).await;
    heart(&t, &ben, &hearted).await;
    // Reply group: deleting the thread (by the game owner) removes it.
    let root = comment(&t, &ava, &gid, "question", None).await;
    comment(&t, &ben, &gid, "answer", Some(&root)).await;
    assert_eq!(items(&t, &ava).await.len(), 2);
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{hearted}"),
        &ava,
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let l = items(&t, &ava).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["kind"], "reply");
    let r = send_empty(&t, Method::DELETE, &format!("/api/comments/{root}"), &owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(items(&t, &ava).await.is_empty());
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE kind IN ('heart', 'reply')"
        )
        .await,
        0
    );

    // Comment group: the owner's unread item now holds ava's two comments plus ben's.
    let g2 = game(&t, &owner, "Space Dodge", true).await;
    let c1 = comment(&t, &ava, &g2, "c1", None).await;
    tick().await;
    let c2 = comment(&t, &ben, &g2, "c2", None).await;
    let find = |l: &[Value]| {
        l.iter()
            .find(|n| n["game"]["id"] == g2.as_str())
            .cloned()
            .unwrap()
    };
    let n = find(&items(&t, &owner).await);
    assert_eq!(n["eventCount"], 2);
    assert_eq!(n["commentId"], c2.as_str());

    // Admin resolve `delete` removes c2's event; the group falls back to c1.
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(&ava),
            json!({ "targetType": "comment", "targetId": c2, "reason": "spam" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rid = r.json()["id"].as_str().unwrap().to_string();
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rid}/resolve"),
            Some(&boss),
            json!({ "action": "delete" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let n2 = find(&items(&t, &owner).await);
    assert_eq!(n2["id"], n["id"]);
    assert_eq!(n2["eventCount"], 1);
    assert_eq!(n2["actorCount"], 1);
    assert_eq!(n2["commentId"], c1.as_str());
    assert_eq!(n2["excerpt"], "c1");
    assert_eq!(usernames(&n2["actors"]), vec!["ava"]);

    // The author deletes the last one: the group is deleted with its last event (0014).
    let before = unread(&t, &owner).await["unread"].as_i64().unwrap();
    let r = send_empty(&t, Method::DELETE, &format!("/api/comments/{c1}"), &ava).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let l = items(&t, &owner).await;
    assert!(l.iter().all(|x| x["game"]["id"] != g2.as_str()));
    assert_eq!(unread(&t, &owner).await["unread"], before - 1);
    let id: i64 = n["id"].as_str().unwrap().parse().unwrap();
    let exists = |t: &TestApp| {
        let db = t.state.db.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notifications WHERE id = ?")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap()
        }
    };
    assert_eq!(exists(&t).await, 0, "removed with its last event");
}

// ---------------------------------------------------------------------------
// List contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_order_paging_filters_and_validation() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let mut games = Vec::new();
    for i in 0..5 {
        let gid = game(&t, &owner, &format!("Game {i}"), true).await;
        comment(&t, &ava, &gid, &format!("hi {i}"), None).await;
        games.push(gid);
        tick().await;
    }
    let all = items(&t, &owner).await;
    assert_eq!(all.len(), 5);
    let titles: Vec<&str> = all
        .iter()
        .map(|n| n["game"]["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        titles,
        vec!["Game 4", "Game 3", "Game 2", "Game 1", "Game 0"]
    );
    for w in all.windows(2) {
        assert!(w[0]["updatedAt"].as_str().unwrap() >= w[1]["updatedAt"].as_str().unwrap());
    }

    // Paging with limit=2: 2 + 2 + 1, no duplicates, the same order.
    let mut seen = Vec::new();
    let mut query = "?limit=2".to_string();
    let mut pages = 0;
    loop {
        let p = page(&t, &owner, &query).await;
        pages += 1;
        assert_eq!(p["unread"], 5);
        for n in p["items"].as_array().unwrap() {
            seen.push(n["id"].as_str().unwrap().to_string());
        }
        match p["nextCursor"].as_str() {
            Some(c) => query = format!("?limit=2&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(pages, 3);
    let expected: Vec<String> = all
        .iter()
        .map(|n| n["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(seen, expected);
    // Default limit 20 → one page.
    assert_eq!(page(&t, &owner, "").await["nextCursor"], Value::Null);

    // unread=true lists unread only.
    let r = mark(
        &t,
        &owner,
        json!({ "ids": [all[0]["id"], all[1]["id"]], "upTo": all[0]["updatedAt"] }),
    )
    .await;
    assert_eq!(r.json()["unread"], 3);
    let u = page(&t, &owner, "?unread=true").await;
    assert_eq!(u["items"].as_array().unwrap().len(), 3);
    assert!(
        u["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["read"] == false)
    );
    assert_eq!(u["unread"], 3);
    assert_eq!(
        page(&t, &owner, "?unread=false").await["items"]
            .as_array()
            .unwrap()
            .len(),
        5
    );

    // limit clamps; bad values are 400.
    let p = page(&t, &owner, "?limit=0").await;
    assert_eq!(p["items"].as_array().unwrap().len(), 1);
    assert!(p["nextCursor"].is_string());
    assert_eq!(
        page(&t, &owner, "?limit=500").await["items"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    for bad in [
        "?limit=abc",
        "?limit=1.5",
        "?unread=yes",
        "?cursor=not-a-cursor!",
        "?cursor=bm9wZQ",
    ] {
        let r = t
            .get(&format!("/api/notifications{bad}"), Some(&owner))
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}: {}", r.text());
        assert_eq!(r.error_code(), "bad_request");
    }
    // Auth required.
    assert_eq!(
        t.get("/api/notifications", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn excerpt_is_capped_at_140_characters() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let body: String = "é".repeat(150) + &"x".repeat(50);
    comment(&t, &ava, &gid, &body, None).await;
    let l = items(&t, &owner).await;
    let ex = l[0]["excerpt"].as_str().unwrap();
    assert_eq!(ex.chars().count(), 140);
    assert_eq!(ex, "é".repeat(140));
}

// ---------------------------------------------------------------------------
// Count contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unread_count_caps_at_100_and_reports_latest() {
    let t = setup_with(|c| c.notification_poll_secs = 45).await;
    let (owner, owner_id) = t.register("owen").await;
    let (_, ava_id) = t.register("ava").await;
    let c = unread(&t, &owner).await;
    assert_eq!(
        c,
        json!({ "unread": 0, "latestAt": null, "pollAfterSecs": 45 })
    );

    let base = Utc::now() - chrono::Duration::hours(1);
    let mut latest = String::new();
    for i in 0..120 {
        let ts = stamp(base + chrono::Duration::seconds(i));
        latest = ts.clone();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO notifications (recipient_id, kind, group_key, created_at, updated_at) \
             VALUES (?, 'follow', ?, ?, ?) RETURNING id",
        )
        .bind(&owner_id)
        .bind(format!("bulk:{i}"))
        .bind(&ts)
        .bind(&ts)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO notification_events (notification_id, actor_id, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(&ava_id)
        .bind(&ts)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let c = unread(&t, &owner).await;
    assert_eq!(c["unread"], 100);
    assert_eq!(c["latestAt"], latest.as_str());
    assert_eq!(c["pollAfterSecs"], 45);
    assert_eq!(page(&t, &owner, "").await["unread"], 100);
}

#[tokio::test]
async fn default_poll_after_secs_is_60() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    assert_eq!(unread(&t, &owner).await["pollAfterSecs"], 60);
}

// ---------------------------------------------------------------------------
// Mark-read contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mark_read_scoping_race_guard_and_validation() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let cid = comment(&t, &ava, &gid, "tip", None).await;
    heart(&t, &ben, &cid).await;
    let mine = items(&t, &owner).await[0].clone();
    let avas = items(&t, &ava).await[0].clone();

    // Someone else's id is ignored silently.
    let r = mark(
        &t,
        &owner,
        json!({ "ids": [avas["id"]], "upTo": stamp(Utc::now()) }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), json!({ "unread": 1 }));
    assert_eq!(unread(&t, &ava).await["unread"], 1);
    // Unknown ids too.
    let r = mark(
        &t,
        &owner,
        json!({ "ids": ["999999"], "upTo": stamp(Utc::now()) }),
    )
    .await;
    assert_eq!(r.json()["unread"], 1);

    // upTo older than updatedAt leaves it unread (race guard).
    let updated = chrono::DateTime::parse_from_rfc3339(mine["updatedAt"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    let older = stamp(updated - chrono::Duration::milliseconds(1));
    let r = mark(&t, &owner, json!({ "ids": [mine["id"]], "upTo": older })).await;
    assert_eq!(r.json()["unread"], 1);
    // Non-UTC offsets are normalised before comparing.
    let r = mark(
        &t,
        &owner,
        json!({ "upTo": updated.with_timezone(&chrono::FixedOffset::east_opt(3600).unwrap()).to_rfc3339() }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["unread"], 0);
    // Idempotent.
    let r = mark(&t, &owner, json!({ "upTo": stamp(Utc::now()) })).await;
    assert_eq!(r.json()["unread"], 0);

    // Validation.
    let ids101: Vec<String> = (1..=101).map(|i| i.to_string()).collect();
    for (body, status) in [
        (json!({}), StatusCode::UNPROCESSABLE_ENTITY),
        (json!({ "ids": ["1"] }), StatusCode::UNPROCESSABLE_ENTITY),
        (
            json!({ "upTo": "yesterday" }),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (json!({ "upTo": 5 }), StatusCode::UNPROCESSABLE_ENTITY),
        (
            json!({ "ids": [], "upTo": stamp(Utc::now()) }),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            json!({ "ids": ids101, "upTo": stamp(Utc::now()) }),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            json!({ "ids": [1], "upTo": stamp(Utc::now()) }),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            json!({ "ids": "1", "upTo": stamp(Utc::now()) }),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            json!({ "ids": ["abc"], "upTo": stamp(Utc::now()) }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "ids": ["-3"], "upTo": stamp(Utc::now()) }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "ids": ["0"], "upTo": stamp(Utc::now()) }),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let r = mark(&t, &owner, body.clone()).await;
        assert_eq!(r.status, status, "{body}: {}", r.text());
    }
    // 100 ids is fine.
    let ids100: Vec<String> = (1..=100).map(|i| i.to_string()).collect();
    let r = mark(
        &t,
        &owner,
        json!({ "ids": ids100, "upTo": stamp(Utc::now()) }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.json(
            Method::POST,
            "/api/notifications/read",
            None,
            json!({ "upTo": stamp(Utc::now()) })
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn notifications_share_one_bucket() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    // Writes that create notifications use their own buckets.
    let cid = comment(&t, &ava, &gid, "hi", None).await;
    let own = comment(&t, &owner, &gid, "hello", None).await;
    heart(&t, &owner, &cid).await;
    heart(&t, &ava, &own).await;
    follow(&t, &ava, "owen").await;

    for i in 0..120 {
        let r = match i % 5 {
            0 => t.get("/api/notifications", Some(&owner)).await,
            1 => t.get("/api/notifications/unread-count", Some(&owner)).await,
            2 => t.get("/api/notifications/settings", Some(&owner)).await,
            3 => mark(&t, &owner, json!({ "upTo": stamp(Utc::now()) })).await,
            _ => {
                t.json(
                    Method::PUT,
                    "/api/notifications/settings",
                    Some(&owner),
                    json!({}),
                )
                .await
            }
        };
        assert_eq!(r.status, StatusCode::OK, "request {i}: {}", r.text());
    }
    let r = t.get("/api/notifications/unread-count", Some(&owner)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(r.header("retry-after").parse::<u64>().unwrap() >= 1);
    // The limit comes before validation.
    let r = t.get("/api/notifications?limit=abc", Some(&owner)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Auth comes first.
    assert_eq!(
        t.get("/api/notifications/unread-count", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    // Another user has their own bucket.
    assert_eq!(unread(&t, &ava).await["unread"], 1);

    t.clock.advance(Duration::from_secs(1));
    let r = t.get("/api/notifications/unread-count", Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // Comment/heart/follow writes still work while this bucket is empty.
    for _ in 0..2 {
        let _ = t.get("/api/notifications/unread-count", Some(&owner)).await;
    }
    comment(&t, &owner, &gid, "still here", None).await;
}

// ---------------------------------------------------------------------------
// Best effort
// ---------------------------------------------------------------------------

#[tokio::test]
async fn notification_failures_never_fail_the_trigger() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    follow(&t, &ava, "owen").await;
    for sql in [
        "CREATE TRIGGER f007_fail_insert BEFORE INSERT ON notifications \
         BEGIN SELECT RAISE(ABORT, 'boom'); END",
        "CREATE TRIGGER f007_fail_update BEFORE UPDATE ON notifications \
         BEGIN SELECT RAISE(ABORT, 'boom'); END",
        "CREATE TRIGGER f007_fail_delete BEFORE DELETE ON notification_events \
         BEGIN SELECT RAISE(ABORT, 'boom'); END",
    ] {
        sqlx::query(sql).execute(&t.state.db).await.unwrap();
    }
    // Every trigger point still succeeds: publish (create + PATCH), comment, reply, heart,
    // unheart, unfollow, follow.
    let gid = game(&t, &owner, "Pixel Peaks", true).await;
    let draft = game(&t, &owner, "Draft", false).await;
    patch_published(&t, &owner, &draft, true).await;
    let cid = comment(&t, &ava, &gid, "hi", None).await;
    comment(&t, &owner, &gid, "hello", Some(&cid)).await;
    heart(&t, &owner, &cid).await;
    unheart(&t, &owner, &cid).await;
    unfollow(&t, &ava, "owen").await;
    follow(&t, &ava, "owen").await;
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM comments").await,
        2,
        "the triggering writes committed"
    );
    // Only the follow from before the failure exists.
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 1);
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fan_out_reaches_1200_followers_in_chunks() {
    let t = setup().await;
    let (owner, owner_id) = t.register("rex").await;
    let now = stamp(Utc::now());
    let mut tx = t.state.db.begin().await.unwrap();
    for i in 0..1200 {
        let uid = format!("f{i:04}");
        sqlx::query(
            "INSERT INTO users (id, username, username_lower, email, email_lower, \
             password_hash, display_name, created_at) VALUES (?1, ?1, ?1, ?2, ?2, 'h', ?1, ?3)",
        )
        .bind(&uid)
        .bind(format!("{uid}@x"))
        .bind(&now)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)")
            .bind(&uid)
            .bind(&owner_id)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    let gid = game(&t, &owner, "Lava Leap", true).await;
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT recipient_id) FROM notifications \
         WHERE kind = 'gamePublished' AND game_id = ?",
    )
    .bind(&gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(n, 1200);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events").await,
        1200
    );
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

#[tokio::test]
async fn prune_applies_retention_rules() {
    let t = setup().await;
    let (_, r1) = t.register("rita").await;
    let (_, r2) = t.register("rob").await;
    let (_, actor) = t.register("ava").await;
    let now = Utc::now();
    let days = |d: i64| stamp(now - chrono::Duration::days(d));

    let insert = |recipient: String,
                  key: String,
                  read_at: Option<String>,
                  updated: String,
                  with_event: bool| {
        let db = t.state.db.clone();
        let actor = actor.clone();
        async move {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO notifications (recipient_id, kind, group_key, read_at, created_at, \
                 updated_at) VALUES (?, 'follow', ?, ?, ?, ?) RETURNING id",
            )
            .bind(&recipient)
            .bind(&key)
            .bind(&read_at)
            .bind(&updated)
            .bind(&updated)
            .fetch_one(&db)
            .await
            .unwrap();
            if with_event {
                sqlx::query(
                    "INSERT INTO notification_events (notification_id, actor_id, created_at) \
                     VALUES (?, ?, ?)",
                )
                .bind(id)
                .bind(&actor)
                .bind(&updated)
                .execute(&db)
                .await
                .unwrap();
            }
            id
        }
    };
    let read_old = insert(r1.clone(), "a".into(), Some(days(31)), days(40), true).await;
    let read_recent = insert(r1.clone(), "b".into(), Some(days(29)), days(40), true).await;
    let unread_old = insert(r1.clone(), "c".into(), None, days(91), true).await;
    let unread_recent = insert(r1.clone(), "d".into(), None, days(89), true).await;
    // An event-less row can't exist any more: the 0014 trigger removes it with its last event.
    let empty = insert(r1.clone(), "e".into(), None, days(1), true).await;
    sqlx::query("DELETE FROM notification_events WHERE notification_id = ?")
        .bind(empty)
        .execute(&t.state.db)
        .await
        .unwrap();
    let fresh = insert(r1.clone(), "f".into(), None, days(0), true).await;
    // 205 recent rows for r2: the 5 oldest go.
    let mut r2_ids = Vec::new();
    for i in 0..205 {
        let ts = stamp(now - chrono::Duration::minutes(300 - i));
        r2_ids.push(insert(r2.clone(), format!("k{i}"), None, ts, true).await);
    }

    let deleted = prune(&t.state.db, now).await.unwrap();
    assert_eq!(deleted, 2 + 5);
    let left: Vec<i64> = sqlx::query_scalar("SELECT id FROM notifications ORDER BY id")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    for gone in [read_old, unread_old, empty] {
        assert!(!left.contains(&gone), "{gone} should be pruned");
    }
    for kept in [read_recent, unread_recent, fresh] {
        assert!(left.contains(&kept), "{kept} should be kept");
    }
    for (i, id) in r2_ids.iter().enumerate() {
        assert_eq!(left.contains(id), i >= 5, "r2 row {i}");
    }
    // Events of pruned rows cascade.
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events WHERE notification_id NOT IN (SELECT id FROM notifications)").await,
        0
    );
    // A second run deletes nothing.
    assert_eq!(prune(&t.state.db, now).await.unwrap(), 0);
}

#[tokio::test]
async fn prune_loops_over_batches() {
    let t = setup().await;
    let (_, r1) = t.register("rita").await;
    let old = stamp(Utc::now() - chrono::Duration::days(100));
    let mut tx = t.state.db.begin().await.unwrap();
    for i in 0..2500 {
        sqlx::query(
            "INSERT INTO notifications (recipient_id, kind, group_key, read_at, created_at, \
             updated_at) VALUES (?, 'follow', ?, ?, ?, ?)",
        )
        .bind(&r1)
        .bind(format!("k{i}"))
        .bind(&old)
        .bind(&old)
        .bind(&old)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    assert_eq!(prune(&t.state.db, Utc::now()).await.unwrap(), 2500);
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 0);
}

// ---------------------------------------------------------------------------
// Migration upgrade (0012 → 0013)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0012() {
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
                .filter(|x| x.version <= 12)
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
             ('c1', 'g1', 'u2', 'first', '2026-01-02T00:00:00.000Z')",
            "INSERT INTO comment_hearts (comment_id, user_id, created_at) VALUES \
             ('c1', 'u1', '2026-01-03T00:00:00.000Z')",
            "INSERT INTO follows (follower_id, followee_id, created_at) VALUES \
             ('u2', 'u1', '2026-01-03T00:00:00.000Z')",
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
    // No backfill.
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 0);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_settings").await,
        0
    );
    // Old rows keep working and new events notify.
    let (noah, _) = t.register("noah").await;
    heart(&t, &noah, "c1").await;
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications WHERE recipient_id = 'u2' AND kind = 'heart'",
    )
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(n, 1);
    // The pre-migration heart by u1 is not a notification event, so re-hearting dedupes
    // only against events written after the migration.
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events").await,
        1
    );
}
