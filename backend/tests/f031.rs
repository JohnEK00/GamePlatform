//! F031: post replies and hearts (`GET`/`POST /api/posts/{id}/replies`,
//! `DELETE /api/post-replies/{id}`, `PUT`/`DELETE /api/posts/{id}/heart`,
//! `PUT`/`DELETE /api/posts/{id}/lock`), the `postReply` / `postHeart` notification kinds and
//! settings, `postReply` reports, the 0026 migration, and the review 11 server carry-over
//! (shared forbidden set, displayName / bio characters, banner race).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};
use sqlx::Row;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_string()
}

fn assert_err(r: &Resp, status: StatusCode, code: &str, message: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    let v = r.json();
    assert_eq!(v["error"]["code"], code, "{}", r.text());
    assert_eq!(v["error"]["message"], message, "{}", r.text());
}

fn assert_422(r: &Resp, message: &str) {
    assert_err(r, StatusCode::UNPROCESSABLE_ENTITY, "validation", message);
}

fn assert_404(r: &Resp, message: &str) {
    assert_err(r, StatusCode::NOT_FOUND, "not_found", message);
}

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
}

async fn empty(t: &TestApp, method: Method, uri: &str, tok: Option<&str>) -> Resp {
    t.send(method, uri, tok, None, vec![], &[]).await
}

async fn text_post(t: &TestApp, tok: &str, text: &str) -> String {
    let r = t
        .json(
            Method::POST,
            "/api/posts",
            Some(tok),
            json!({ "body": text }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    s(&r.json()["id"])
}

async fn get_post(t: &TestApp, tok: Option<&str>, id: &str) -> Value {
    let r = t.get(&format!("/api/posts/{id}"), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn reply(t: &TestApp, tok: Option<&str>, pid: &str, body: Value) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/posts/{pid}/replies"),
        tok,
        body,
    )
    .await
}

async fn reply_ok(t: &TestApp, tok: &str, pid: &str, text: &str, to: Option<&str>) -> Value {
    let body = match to {
        Some(r) => json!({ "body": text, "replyToId": r }),
        None => json!({ "body": text }),
    };
    let r = reply(t, Some(tok), pid, body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn reply_id(t: &TestApp, tok: &str, pid: &str, text: &str) -> String {
    s(&reply_ok(t, tok, pid, text, None).await["id"])
}

async fn list(t: &TestApp, tok: Option<&str>, pid: &str, query: &str) -> Resp {
    t.get(&format!("/api/posts/{pid}/replies{query}"), tok)
        .await
}

async fn list_ok(t: &TestApp, tok: Option<&str>, pid: &str, query: &str) -> Value {
    let r = list(t, tok, pid, query).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn del_reply(t: &TestApp, tok: Option<&str>, rid: &str) -> Resp {
    empty(t, Method::DELETE, &format!("/api/post-replies/{rid}"), tok).await
}

async fn heart(t: &TestApp, tok: Option<&str>, pid: &str, on: bool) -> Resp {
    let m = if on { Method::PUT } else { Method::DELETE };
    empty(t, m, &format!("/api/posts/{pid}/heart"), tok).await
}

async fn heart_ok(t: &TestApp, tok: &str, pid: &str, on: bool) -> Value {
    let r = heart(t, Some(tok), pid, on).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn lock(t: &TestApp, tok: Option<&str>, pid: &str, on: bool) -> Resp {
    let m = if on { Method::PUT } else { Method::DELETE };
    empty(t, m, &format!("/api/posts/{pid}/lock"), tok).await
}

async fn all_items(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

async fn of_kind(t: &TestApp, tok: &str, kind: &str) -> Vec<Value> {
    all_items(t, tok)
        .await
        .into_iter()
        .filter(|i| i["kind"] == kind)
        .collect()
}

async fn unread(t: &TestApp, tok: &str) -> i64 {
    let r = t.get("/api/notifications/unread-count", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["unread"].as_i64().unwrap()
}

async fn mark_all(t: &TestApp, tok: &str) {
    let r = t
        .get("/api/notifications/unread-count", Some(tok))
        .await
        .json();
    let r = t
        .json(
            Method::POST,
            "/api/notifications/read",
            Some(tok),
            json!({ "upTo": r["latestAt"] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn put_settings(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::PUT, "/api/notifications/settings", Some(tok), body)
        .await
}

async fn report(t: &TestApp, tok: &str, target_type: &str, id: &str) -> Resp {
    t.json(
        Method::POST,
        "/api/reports",
        Some(tok),
        json!({ "targetType": target_type, "targetId": id, "reason": "spam" }),
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

async fn report_state(t: &TestApp, id: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT status, resolution FROM reports WHERE id = ?")
        .bind(id)
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

async fn follow(t: &TestApp, tok: &str, username: &str) {
    let r = empty(
        t,
        Method::PUT,
        &format!("/api/users/{username}/follow"),
        Some(tok),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

fn assert_social(p: &Value, hearts: i64, my_heart: bool, replies: i64, locked: bool) {
    assert_eq!(p["hearts"], hearts, "{p}");
    assert_eq!(p["myHeart"], my_heart, "{p}");
    assert_eq!(p["replyCount"], replies, "{p}");
    assert_eq!(p["locked"], locked, "{p}");
}

/// The review 11 additions to the shared forbidden set.
const REVIEW11: [char; 8] = [
    '\u{061C}', '\u{115F}', '\u{1160}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{3164}', '\u{FFA0}',
];

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0025() {
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
                .filter(|x| x.version <= 25)
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
                 ('u2', 'Ben', 'ben', 'u2@x', 'u2@x', 'h', 'Ben', '{ts}', 'user')"
            ),
            format!(
                "INSERT INTO posts (id, author_id, body, attachment_type, game_id, \
                 collection_id, created_at) VALUES ('p1', 'u1', 'Hello', NULL, NULL, NULL, '{ts}')"
            ),
            format!(
                "INSERT INTO notifications (id, recipient_id, kind, group_key, game_id, \
                 comment_id, created_at, updated_at) VALUES \
                 (5, 'u1', 'follow', 'follow', NULL, NULL, '{ts}', '{ts}')"
            ),
            format!(
                "INSERT INTO notification_events (notification_id, actor_id, comment_id, \
                 created_at) VALUES (5, 'u2', NULL, '{ts}')"
            ),
            format!(
                "INSERT INTO notification_settings (user_id, comments, updated_at) \
                 VALUES ('u1', 0, '{ts}')"
            ),
            format!(
                "INSERT INTO reports (id, target_type, target_id, target_game_id, \
                 target_preview, reason, details, reporter_id, status, created_at) VALUES \
                 ('r1', 'post', 'p1', NULL, 'Hello', 'spam', '', 'u2', 'open', '{ts}')"
            ),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        db.close().await;
    }

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    let (hearts, replies, locked): (i64, i64, Option<String>) =
        sqlx::query_as("SELECT hearts, reply_count, locked_at FROM posts WHERE id = 'p1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((hearts, replies, locked), (0, 0, None));
    let (comments, pr, ph): (i64, i64, i64) = sqlx::query_as(
        "SELECT comments, post_replies, post_hearts FROM notification_settings \
         WHERE user_id = 'u1'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!((comments, pr, ph), (0, 1, 1));
    let target_post: Option<String> =
        sqlx::query_scalar("SELECT target_post_id FROM reports WHERE id = 'r1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(target_post.as_deref(), Some("p1"));
    let (nid, post_id): (i64, Option<String>) =
        sqlx::query_as("SELECT id, post_id FROM notifications")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((nid, post_id), (5, None));
    let ev: Option<String> = sqlx::query_scalar("SELECT post_reply_id FROM notification_events")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(ev, None);

    let dedupe: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_notification_events_dedupe'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(dedupe.contains("IFNULL(post_reply_id, '')"), "{dedupe}");
    assert!(dedupe.contains("IFNULL(screenshot_id, '')"), "{dedupe}");
    assert!(dedupe.contains("UNIQUE"), "{dedupe}");
    let triggers: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN \
         ('trg_post_hearts_insert', 'trg_post_hearts_delete', 'trg_post_replies_insert', \
          'trg_post_replies_delete') ORDER BY name",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(triggers.len(), 4, "{triggers:?}");

    let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&db)
        .await
        .unwrap();
    assert!(fk.is_empty(), "{fk:?}");
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}

// ---------------------------------------------------------------------------
// Post fields
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_carries_the_social_fields_everywhere() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    follow(&t, &leo, "mia").await;
    let r = t
        .json(
            Method::POST,
            "/api/posts",
            Some(&mia),
            json!({ "body": "hi" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let created = r.json();
    assert_social(&created, 0, false, 0, false);
    let pid = s(&created["id"]);
    assert_social(&get_post(&t, None, &pid).await, 0, false, 0, false);

    heart_ok(&t, &leo, &pid, true).await;
    reply_id(&t, &leo, &pid, "first").await;
    assert_social(&get_post(&t, Some(&leo), &pid).await, 1, true, 1, false);
    assert_social(&get_post(&t, Some(&mia), &pid).await, 1, false, 1, false);
    assert_social(&get_post(&t, None, &pid).await, 1, false, 1, false);

    let r = t.get("/api/users/mia/posts", Some(&leo)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_social(&r.json()["items"][0], 1, true, 1, false);

    let r = t.get("/api/feed", Some(&leo)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let items = r.json()["items"].as_array().unwrap().clone();
    let item = items
        .iter()
        .find(|i| i["kind"] == "postCreated")
        .expect("postCreated item");
    assert_social(&item["post"], 1, true, 1, false);
}

// ---------------------------------------------------------------------------
// Hearts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hearts() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, leo_id) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let pid = text_post(&t, &mia, "Look at this").await;

    assert_eq!(
        heart_ok(&t, &leo, &pid, true).await,
        json!({ "hearted": true, "hearts": 1 })
    );
    assert_eq!(
        heart_ok(&t, &leo, &pid, true).await,
        json!({ "hearted": true, "hearts": 1 })
    );
    assert_eq!(get_post(&t, Some(&leo), &pid).await["myHeart"], true);
    let anon = get_post(&t, None, &pid).await;
    assert_eq!(
        (anon["myHeart"].clone(), anon["hearts"].clone()),
        (json!(false), json!(1))
    );

    // The author can't heart; DELETE on your own post is a harmless no-op.
    assert_422(
        &heart(&t, Some(&mia), &pid, true).await,
        "You can't heart your own post",
    );
    assert_eq!(
        heart_ok(&t, &mia, &pid, false).await,
        json!({ "hearted": false, "hearts": 1 })
    );

    assert_eq!(
        heart_ok(&t, &leo, &pid, false).await,
        json!({ "hearted": false, "hearts": 0 })
    );
    assert_eq!(
        heart_ok(&t, &leo, &pid, false).await,
        json!({ "hearted": false, "hearts": 0 })
    );

    assert_404(&heart(&t, Some(&leo), "nope", true).await, "Post not found");
    assert_404(
        &heart(&t, Some(&leo), "nope", false).await,
        "Post not found",
    );
    assert_eq!(
        heart(&t, None, &pid, true).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        heart(&t, None, &pid, false).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Deleting an account drops its hearts (trigger).
    heart_ok(&t, &leo, &pid, true).await;
    heart_ok(&t, &kai, &pid, true).await;
    assert_eq!(get_post(&t, None, &pid).await["hearts"], 2);
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&leo_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(get_post(&t, None, &pid).await["hearts"], 1);
}

#[tokio::test]
async fn heart_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let pid = text_post(&t, &mia, "x").await;
    for i in 0..120 {
        let r = heart(&t, Some(&leo), &pid, i % 2 == 0).await;
        assert_eq!(r.status, StatusCode::OK, "{i}: {}", r.text());
    }
    let r = heart(&t, Some(&leo), &pid, true).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());
    // An unknown post is a 404 before the bucket is touched.
    assert_404(&heart(&t, Some(&leo), "nope", true).await, "Post not found");
    t.clock.advance(Duration::from_secs(600));
    assert_eq!(
        heart(&t, Some(&leo), &pid, true).await.status,
        StatusCode::OK
    );
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_reply_rules() {
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    let (leo, leo_id) = t.register("leo").await;
    let pid = text_post(&t, &mia, "Post").await;
    let other = text_post(&t, &mia, "Other post").await;

    let r = reply_ok(&t, &leo, &pid, "  hi\r\nthere ", None).await;
    let rid = s(&r["id"]);
    assert_eq!(r["body"], "hi\nthere");
    assert_eq!(r["postId"], pid.as_str());
    assert_eq!(r["author"]["id"], leo_id.as_str());
    assert_eq!(r["replyTo"], Value::Null);
    assert_eq!(r["byPostAuthor"], false);
    assert_eq!(r["canDelete"], true);
    assert_eq!(r["path"], format!("/p/{pid}?reply={rid}"));
    assert!(s(&r["createdAt"]).ends_with('Z'));
    assert_eq!(get_post(&t, None, &pid).await["replyCount"], 1);

    // Every F030 body message.
    for (body, msg) in [
        (json!(""), "body must be 1–500 characters"),
        (json!(" \r\n "), "body must be 1–500 characters"),
        (json!("é".repeat(501)), "body must be 1–500 characters"),
        (json!(["l"; 13].join("\n")), "body must be at most 12 lines"),
        (json!("a\tb"), "body must be plain text"),
        (json!("a\u{202E}b"), "body must be plain text"),
        // Review 11: U+2028 can't get around the line cap.
        (json!(["l"; 13].join("\u{2028}")), "body must be plain text"),
    ] {
        assert_422(
            &reply(&t, Some(&leo), &pid, json!({ "body": body })).await,
            msg,
        );
    }
    assert!(
        reply(&t, Some(&leo), &pid, json!({ "body": "é".repeat(500) }))
            .await
            .status
            .is_success()
    );

    // Mia answers Leo's reply → replyTo = Leo, byPostAuthor.
    let m = reply_ok(&t, &mia, &pid, "thanks", Some(&rid)).await;
    assert_eq!(m["replyTo"]["id"], leo_id.as_str());
    assert_eq!(m["replyTo"]["username"], "leo");
    assert_eq!(m["byPostAuthor"], true);
    // Leo answering his own reply → replyTo null; answering Mia's → Mia.
    let own = reply_ok(&t, &leo, &pid, "me again", Some(&rid)).await;
    assert_eq!(own["replyTo"], Value::Null);
    let back = reply_ok(&t, &leo, &pid, "to mia", Some(&s(&m["id"]))).await;
    assert_eq!(back["replyTo"]["id"], mia_id.as_str());
    // explicit null = answering the post
    let r = reply(
        &t,
        Some(&leo),
        &pid,
        json!({ "body": "x", "replyToId": null }),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(r.json()["replyTo"], Value::Null);

    // A reply of another post, or an unknown id → 404 Reply not found.
    let elsewhere = reply_id(&t, &leo, &other, "elsewhere").await;
    assert_404(
        &reply(
            &t,
            Some(&leo),
            &pid,
            json!({ "body": "x", "replyToId": elsewhere }),
        )
        .await,
        "Reply not found",
    );
    assert_404(
        &reply(
            &t,
            Some(&leo),
            &pid,
            json!({ "body": "x", "replyToId": "nope" }),
        )
        .await,
        "Reply not found",
    );
    // Wrong JSON types → 422 (extractor); malformed → 400.
    let r = reply(&t, Some(&leo), &pid, json!({ "body": "x", "replyToId": 3 })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    let r = reply(&t, Some(&leo), &pid, json!({ "body": 5 })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    let r = t
        .send(
            Method::POST,
            &format!("/api/posts/{pid}/replies"),
            Some(&leo),
            Some("application/json"),
            b"{nope".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());

    assert_404(
        &reply(&t, Some(&leo), "nope", json!({ "body": "x" })).await,
        "Post not found",
    );
    // The post is looked up before the body is validated.
    assert_404(
        &reply(&t, Some(&leo), "nope", json!({ "body": "" })).await,
        "Post not found",
    );
    assert_eq!(
        reply(&t, None, &pid, json!({ "body": "x" })).await.status,
        StatusCode::UNAUTHORIZED
    );

    // replyTo becomes null when that user is deleted.
    let r2 = reply_ok(&t, &mia, &pid, "to leo", Some(&rid)).await;
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&leo_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let items = list_ok(&t, None, &pid, "").await["items"]
        .as_array()
        .unwrap()
        .clone();
    let kept = items.iter().find(|i| i["id"] == r2["id"]).unwrap();
    assert_eq!(kept["replyTo"], Value::Null);
    // Leo's replies went with his account (cascade + counter trigger).
    let listed = list_ok(&t, None, &pid, "").await;
    assert_eq!(listed["total"], listed["items"].as_array().unwrap().len());
    assert_eq!(
        get_post(&t, None, &pid).await["replyCount"],
        listed["total"]
    );
}

#[tokio::test]
async fn list_replies() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let (boss, _) = t.register("boss").await;
    let pid = text_post(&t, &mia, "Post").await;
    let mut ids = Vec::new();
    for i in 0..5 {
        let tok = if i % 2 == 0 { &leo } else { &kai };
        ids.push(reply_id(&t, tok, &pid, &format!("r{i}")).await);
    }
    // Same timestamp: insertion order breaks the tie.
    sqlx::query("UPDATE post_replies SET created_at = '2026-01-01T00:00:00.000Z'")
        .execute(&t.state.db)
        .await
        .unwrap();

    let page = list_ok(&t, None, &pid, "").await;
    assert_eq!(page["total"], 5);
    assert_eq!(page["page"], 1);
    assert_eq!(page["perPage"], 50);
    let got: Vec<String> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| s(&i["id"]))
        .collect();
    assert_eq!(got, ids);

    let p2 = list_ok(&t, None, &pid, "?page=2&perPage=2").await;
    assert_eq!(p2["items"][0]["id"], ids[2].as_str());
    assert_eq!(p2["items"].as_array().unwrap().len(), 2);
    assert_eq!(list_ok(&t, None, &pid, "?perPage=0").await["perPage"], 1);
    assert_eq!(
        list_ok(&t, None, &pid, "?perPage=500").await["perPage"],
        200
    );
    assert_eq!(
        list_ok(&t, None, &pid, "?perPage=200").await["perPage"],
        200
    );
    assert_err(
        &list(&t, None, &pid, "?page=x").await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "page must be an integer",
    );
    assert_err(
        &list(&t, None, &pid, "?perPage=x").await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "perPage must be an integer",
    );
    assert_404(&list(&t, None, "nope", "?page=x").await, "Post not found");

    // canDelete: reply author, post author, admin.
    let can = |v: &Value| -> Vec<bool> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["canDelete"].as_bool().unwrap())
            .collect()
    };
    assert_eq!(can(&list_ok(&t, None, &pid, "").await), vec![false; 5]);
    assert_eq!(can(&list_ok(&t, Some(&mia), &pid, "").await), vec![true; 5]);
    assert_eq!(
        can(&list_ok(&t, Some(&boss), &pid, "").await),
        vec![true; 5]
    );
    assert_eq!(
        can(&list_ok(&t, Some(&leo), &pid, "").await),
        vec![true, false, true, false, true]
    );
    let (other, _) = t.register("zed").await;
    assert_eq!(
        can(&list_ok(&t, Some(&other), &pid, "").await),
        vec![false; 5]
    );
}

#[tokio::test]
async fn reply_page_plan_uses_the_post_index() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let a = text_post(&t, &mia, "a").await;
    let b = text_post(&t, &mia, "b").await;
    for i in 0..5 {
        reply_id(&t, &leo, &a, &format!("a{i}")).await;
        reply_id(&t, &leo, &b, &format!("b{i}")).await;
    }
    webgame_server::db::optimize(&t.state.db, true).await;
    sqlx::query("ANALYZE").execute(&t.state.db).await.unwrap();
    let sql = format!(
        "EXPLAIN QUERY PLAN {}",
        webgame_server::routes::post_replies::post_replies_page_sql()
    );
    let plan: Vec<String> = sqlx::query(&sql)
        .bind(&a)
        .bind(50)
        .bind(0)
        .fetch_all(&t.state.db)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap())
        .collect();
    let text = plan.join("\n");
    assert!(text.contains("idx_post_replies_post_created"), "{text}");
    assert!(!text.contains("USE TEMP B-TREE"), "{text}");
}

#[tokio::test]
async fn reply_cap() {
    let t = setup().await; // RATE_LIMIT off
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let pid = text_post(&t, &mia, "Popular").await;
    let mut last = String::new();
    for i in 0..200 {
        last = reply_id(&t, &leo, &pid, &format!("r{i}")).await;
    }
    assert_422(
        &reply(&t, Some(&leo), &pid, json!({ "body": "one more" })).await,
        "This post has reached 200 replies",
    );
    // The author and admins are capped too.
    assert_422(
        &reply(&t, Some(&mia), &pid, json!({ "body": "one more" })).await,
        "This post has reached 200 replies",
    );
    assert_eq!(get_post(&t, None, &pid).await["replyCount"], 200);
    assert_eq!(
        list_ok(&t, None, &pid, "?perPage=200").await["items"]
            .as_array()
            .unwrap()
            .len(),
        200
    );
    assert_eq!(
        del_reply(&t, Some(&leo), &last).await.status,
        StatusCode::NO_CONTENT
    );
    reply_id(&t, &leo, &pid, "freed").await;
    assert_422(
        &reply(&t, Some(&leo), &pid, json!({ "body": "again" })).await,
        "This post has reached 200 replies",
    );
}

#[tokio::test]
async fn reply_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let pid = text_post(&t, &mia, "x").await;
    // An unknown post doesn't use a token; a 422 does.
    for _ in 0..3 {
        assert_404(
            &reply(&t, Some(&leo), "nope", json!({ "body": "x" })).await,
            "Post not found",
        );
    }
    assert_422(
        &reply(&t, Some(&leo), &pid, json!({ "body": "" })).await,
        "body must be 1–500 characters",
    );
    for i in 0..29 {
        reply_id(&t, &leo, &pid, &format!("r{i}")).await;
    }
    let r = reply(&t, Some(&leo), &pid, json!({ "body": "x" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    assert_eq!(r.error_code(), "rate_limited");
    // Other users have their own bucket.
    reply_id(&t, &mia, &pid, "mine").await;
    t.clock.advance(Duration::from_secs(600));
    reply_id(&t, &leo, &pid, "later").await;
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lock_and_unlock() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let (boss, _) = t.register("boss").await;
    let pid = text_post(&t, &mia, "Post").await;
    let leo_reply = reply_id(&t, &leo, &pid, "before").await;

    assert_err(
        &lock(&t, Some(&leo), &pid, true).await,
        StatusCode::FORBIDDEN,
        "forbidden",
        "You do not have permission to do that",
    );
    assert_eq!(
        lock(&t, None, &pid, true).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_404(&lock(&t, Some(&mia), "nope", true).await, "Post not found");

    let r = lock(&t, Some(&mia), &pid, true).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let p = r.json();
    assert_eq!(p["locked"], true);
    assert_eq!(p["id"], pid.as_str());
    assert_eq!(p["canDelete"], true);
    let first: String = sqlx::query_scalar("SELECT locked_at FROM posts WHERE id = ?")
        .bind(&pid)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(
        lock(&t, Some(&mia), &pid, true).await.json()["locked"],
        true
    );
    let again: String = sqlx::query_scalar("SELECT locked_at FROM posts WHERE id = ?")
        .bind(&pid)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(
        lock(&t, Some(&boss), &pid, true).await.status,
        StatusCode::OK
    );
    assert_eq!(get_post(&t, None, &pid).await["locked"], true);

    // While locked: others → 422; the author and admins can still reply.
    assert_422(
        &reply(&t, Some(&leo), &pid, json!({ "body": "x" })).await,
        "Replies are turned off for this post",
    );
    // The body is validated before the lock is checked.
    assert_422(
        &reply(&t, Some(&leo), &pid, json!({ "body": "" })).await,
        "body must be 1–500 characters",
    );
    reply_id(&t, &mia, &pid, "author").await;
    reply_id(&t, &boss, &pid, "admin").await;
    // Hearts, reports and deletes keep working.
    heart_ok(&t, &leo, &pid, true).await;
    assert_eq!(
        report(&t, &kai, "postReply", &leo_reply).await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        del_reply(&t, Some(&leo), &leo_reply).await.status,
        StatusCode::NO_CONTENT
    );

    let before = count(&t, "SELECT COUNT(*) FROM notifications WHERE kind <> ?", "").await;
    let r = lock(&t, Some(&mia), &pid, false).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["locked"], false);
    assert_eq!(
        lock(&t, Some(&mia), &pid, false).await.json()["locked"],
        false
    );
    assert_eq!(
        lock(&t, Some(&mia), &pid, true).await.status,
        StatusCode::OK
    );
    assert_eq!(
        lock(&t, Some(&boss), &pid, false).await.status,
        StatusCode::OK
    );
    let after = count(&t, "SELECT COUNT(*) FROM notifications WHERE kind <> ?", "").await;
    assert_eq!(before, after, "locking never notifies");
    reply_id(&t, &leo, &pid, "back").await;
}

#[tokio::test]
async fn lock_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let pid = text_post(&t, &mia, "x").await;
    for i in 0..60 {
        assert_eq!(
            lock(&t, Some(&mia), &pid, i % 2 == 0).await.status,
            StatusCode::OK
        );
    }
    assert_eq!(
        lock(&t, Some(&mia), &pid, true).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // 403 comes before the bucket.
    assert_eq!(
        lock(&t, Some(&leo), &pid, true).await.status,
        StatusCode::FORBIDDEN
    );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_replies() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let (boss, _) = t.register("boss").await;
    let pid = text_post(&t, &mia, "Post").await;
    let a = reply_id(&t, &leo, &pid, "a").await;
    let b = reply_id(&t, &leo, &pid, "b").await;
    let c = reply_id(&t, &leo, &pid, "c").await;

    assert_err(
        &del_reply(&t, Some(&kai), &a).await,
        StatusCode::FORBIDDEN,
        "forbidden",
        "You do not have permission to do that",
    );
    assert_eq!(
        del_reply(&t, None, &a).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        del_reply(&t, Some(&leo), &a).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        del_reply(&t, Some(&mia), &b).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        del_reply(&t, Some(&boss), &c).await.status,
        StatusCode::NO_CONTENT
    );
    assert_404(&del_reply(&t, Some(&leo), &a).await, "Reply not found");
    assert_eq!(get_post(&t, None, &pid).await["replyCount"], 0);
}

#[tokio::test]
async fn deleting_the_post_cascades() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let pid = text_post(&t, &mia, "Post").await;
    let keep = text_post(&t, &mia, "Keep").await;
    let rid = reply_id(&t, &leo, &pid, "reply").await;
    let kept_reply = reply_id(&t, &leo, &keep, "kept").await;
    heart_ok(&t, &leo, &pid, true).await;
    let post_report = s(&report(&t, &kai, "post", &pid).await.json()["id"]);
    let reply_report = s(&report(&t, &kai, "postReply", &rid).await.json()["id"]);
    let other_report = s(&report(&t, &kai, "postReply", &kept_reply).await.json()["id"]);
    assert_eq!(of_kind(&t, &mia, "postReply").await.len(), 2);
    assert_eq!(of_kind(&t, &mia, "postHeart").await.len(), 1);

    let r = empty(&t, Method::DELETE, &format!("/api/posts/{pid}"), Some(&mia)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM post_replies WHERE post_id = ?",
            &pid
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM post_hearts WHERE post_id = ?",
            &pid
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE post_id = ?",
            &pid
        )
        .await,
        0
    );
    let left = of_kind(&t, &mia, "postReply").await;
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["postId"], keep.as_str());
    assert!(of_kind(&t, &mia, "postHeart").await.is_empty());
    assert_eq!(unread(&t, &mia).await, 1);
    assert_eq!(
        report_state(&t, &post_report).await,
        ("resolved".into(), Some("delete".into()))
    );
    assert_eq!(
        report_state(&t, &reply_report).await,
        ("resolved".into(), Some("delete".into()))
    );
    assert_eq!(report_state(&t, &other_report).await, ("open".into(), None));
    let fk: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert!(fk.is_empty(), "{fk:?}");
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reply_notifications() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, leo_id) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let pid = text_post(&t, &mia, "Mia's post").await;

    let r1 = reply_id(&t, &leo, &pid, "Can't wait for world 3!").await;
    let n = of_kind(&t, &mia, "postReply").await;
    assert_eq!(n.len(), 1);
    let n0 = &n[0];
    assert_eq!(n0["actors"].as_array().unwrap().len(), 1);
    assert_eq!(n0["actors"][0]["id"], leo_id.as_str());
    assert_eq!(n0["actorCount"], 1);
    assert_eq!(n0["eventCount"], 1);
    assert_eq!(n0["ownsThread"], true);
    assert_eq!(n0["postId"], pid.as_str());
    assert_eq!(n0["excerpt"], "Can't wait for world 3!");
    assert_eq!(n0["path"], format!("/p/{pid}?reply={r1}"));
    assert_eq!(n0["game"], Value::Null);
    assert_eq!(n0["commentId"], Value::Null);
    assert_eq!(n0["threadId"], Value::Null);
    assert_eq!(n0["collection"], Value::Null);
    assert_eq!(n0["screenshot"], Value::Null);
    assert_eq!(n0["creatorHeart"], false);
    assert_eq!(n0["read"], false);
    assert_eq!(unread(&t, &mia).await, 1);
    // Leo (the actor) got nothing.
    assert!(all_items(&t, &leo).await.is_empty());

    let r2 = reply_id(&t, &leo, &pid, "Second").await;
    let n = of_kind(&t, &mia, "postReply").await;
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["id"], n0["id"]);
    assert_eq!(n[0]["eventCount"], 2);
    assert_eq!(n[0]["actorCount"], 1);
    assert_eq!(n[0]["excerpt"], "Second");
    assert_eq!(n[0]["path"], format!("/p/{pid}?reply={r2}"));
    reply_id(&t, &kai, &pid, "Kai here").await;
    let n = of_kind(&t, &mia, "postReply").await;
    assert_eq!(n[0]["actorCount"], 2);
    assert_eq!(n[0]["eventCount"], 3);
    assert_eq!(unread(&t, &mia).await, 1);

    // Mia answers Leo → Leo gets postReply (ownsThread false); Mia gets nothing new.
    let m = reply_ok(&t, &mia, &pid, "Thanks Leo", Some(&r1)).await;
    let ln = of_kind(&t, &leo, "postReply").await;
    assert_eq!(ln.len(), 1);
    assert_eq!(ln[0]["ownsThread"], false);
    assert_eq!(ln[0]["excerpt"], "Thanks Leo");
    assert_eq!(ln[0]["path"], format!("/p/{pid}?reply={}", s(&m["id"])));
    assert_eq!(of_kind(&t, &mia, "postReply").await[0]["eventCount"], 3);

    // Leo answers Mia's reply on Mia's post → Mia gets one event, not two.
    reply_ok(&t, &leo, &pid, "You're welcome", Some(&s(&m["id"]))).await;
    assert_eq!(of_kind(&t, &mia, "postReply").await[0]["eventCount"], 4);

    // Kai answers Leo's reply → Mia (post author) and Leo (replyTo) each get one.
    let k = reply_ok(&t, &kai, &pid, "@leo hi", Some(&r1)).await;
    assert_eq!(of_kind(&t, &mia, "postReply").await[0]["eventCount"], 5);
    let ln = of_kind(&t, &leo, "postReply").await;
    assert_eq!(ln[0]["eventCount"], 2);
    assert_eq!(ln[0]["path"], format!("/p/{pid}?reply={}", s(&k["id"])));

    // Deleting the newest reply moves the path back.
    assert_eq!(
        del_reply(&t, Some(&kai), &s(&k["id"])).await.status,
        StatusCode::NO_CONTENT
    );
    let ln = of_kind(&t, &leo, "postReply").await;
    assert_eq!(ln[0]["eventCount"], 1);
    assert_eq!(ln[0]["path"], format!("/p/{pid}?reply={}", s(&m["id"])));
    // Deleting every reply in a group deletes it, read or unread.
    mark_all(&t, &leo).await;
    assert_eq!(unread(&t, &leo).await, 0);
    assert_eq!(
        del_reply(&t, Some(&mia), &s(&m["id"])).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(of_kind(&t, &leo, "postReply").await.is_empty());
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE recipient_id = ? AND kind = 'postReply'",
            &leo_id,
        )
        .await,
        0
    );
}

#[tokio::test]
async fn reply_notification_newest_and_read_groups() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let pid = text_post(&t, &mia, "Post").await;
    let a = reply_id(&t, &leo, &pid, "a").await;
    let b = reply_id(&t, &leo, &pid, "b").await;
    assert_eq!(
        of_kind(&t, &mia, "postReply").await[0]["path"],
        format!("/p/{pid}?reply={b}")
    );
    assert_eq!(
        del_reply(&t, Some(&leo), &b).await.status,
        StatusCode::NO_CONTENT
    );
    let n = of_kind(&t, &mia, "postReply").await;
    assert_eq!(n[0]["eventCount"], 1);
    assert_eq!(n[0]["excerpt"], "a");
    assert_eq!(n[0]["path"], format!("/p/{pid}?reply={a}"));

    // After reading, a new reply starts a new unread group.
    mark_all(&t, &mia).await;
    let c = reply_id(&t, &leo, &pid, "c").await;
    let n = of_kind(&t, &mia, "postReply").await;
    assert_eq!(n.len(), 2);
    assert_eq!(n[0]["read"], false);
    assert_eq!(n[0]["path"], format!("/p/{pid}?reply={c}"));
    assert_eq!(n[1]["read"], true);
    assert_eq!(unread(&t, &mia).await, 1);
}

#[tokio::test]
async fn heart_notifications() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, leo_id) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let pid = text_post(&t, &mia, "Dev log: world 3 is coming").await;

    heart_ok(&t, &leo, &pid, true).await;
    let n = of_kind(&t, &mia, "postHeart").await;
    assert_eq!(n.len(), 1);
    let n0 = n[0].clone();
    assert_eq!(n0["actors"][0]["id"], leo_id.as_str());
    assert_eq!(n0["actorCount"], 1);
    assert_eq!(n0["eventCount"], 1);
    assert_eq!(n0["ownsThread"], false);
    assert_eq!(n0["excerpt"], "Dev log: world 3 is coming");
    assert_eq!(n0["path"], format!("/p/{pid}"));
    assert_eq!(n0["postId"], pid.as_str());
    assert_eq!(n0["game"], Value::Null);
    assert_eq!(n0["commentId"], Value::Null);
    assert_eq!(n0["threadId"], Value::Null);
    assert_eq!(unread(&t, &mia).await, 1);

    // Un-heart while unread → not listed; heart again → restored without moving.
    heart_ok(&t, &leo, &pid, false).await;
    assert!(of_kind(&t, &mia, "postHeart").await.is_empty());
    assert_eq!(unread(&t, &mia).await, 0);
    heart_ok(&t, &leo, &pid, true).await;
    let n = of_kind(&t, &mia, "postHeart").await;
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["id"], n0["id"]);
    assert_eq!(n[0]["updatedAt"], n0["updatedAt"]);
    assert_eq!(unread(&t, &mia).await, 1);

    heart_ok(&t, &kai, &pid, true).await;
    let n = of_kind(&t, &mia, "postHeart").await;
    assert_eq!(n[0]["actorCount"], 2);
    assert_eq!(n[0]["eventCount"], 2);

    // Once read, toggling never re-notifies (actor dedupe).
    mark_all(&t, &mia).await;
    heart_ok(&t, &leo, &pid, false).await;
    heart_ok(&t, &leo, &pid, true).await;
    assert_eq!(unread(&t, &mia).await, 0);
    assert_eq!(of_kind(&t, &mia, "postHeart").await.len(), 1);
}

#[tokio::test]
async fn settings_and_mutes() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let r = t.get("/api/notifications/settings", Some(&mia)).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["postReplies"], true);
    assert_eq!(v["postHearts"], true);
    assert_422(
        &put_settings(&t, &mia, json!({ "postHearts": 1 })).await,
        "postHearts must be a boolean",
    );
    assert_422(
        &put_settings(&t, &mia, json!({ "postReplies": "no" })).await,
        "postReplies must be a boolean",
    );

    // Mutes on Mia's game and a thread never affect post kinds.
    let gid = s(&t.create_game(&mia, "Game", "", true).await["id"]);
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&leo),
            json!({ "body": "hello" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let cid = s(&r.json()["id"]);
    for uri in [
        format!("/api/notifications/mutes/games/{gid}"),
        format!("/api/notifications/mutes/threads/{cid}"),
    ] {
        let r = empty(&t, Method::PUT, &uri, Some(&mia)).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
    }
    let pid = text_post(&t, &mia, "Post").await;
    reply_id(&t, &leo, &pid, "x").await;
    heart_ok(&t, &leo, &pid, true).await;
    assert_eq!(of_kind(&t, &mia, "postReply").await.len(), 1);
    assert_eq!(of_kind(&t, &mia, "postHeart").await.len(), 1);

    // postReplies off → no postReply; postHearts off → no postHeart.
    let r = put_settings(
        &t,
        &mia,
        json!({ "postReplies": false, "postHearts": false }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(
        (v["postReplies"].clone(), v["postHearts"].clone()),
        (json!(false), json!(false))
    );
    assert_eq!(v["comments"], true);
    mark_all(&t, &mia).await;
    let p2 = text_post(&t, &mia, "Post 2").await;
    reply_id(&t, &leo, &p2, "y").await;
    heart_ok(&t, &leo, &p2, true).await;
    assert_eq!(unread(&t, &mia).await, 0);
    assert!(
        all_items(&t, &mia)
            .await
            .iter()
            .all(|i| i["postId"] != p2.as_str())
    );
    // Partial update keeps the other.
    let r = put_settings(&t, &mia, json!({ "postHearts": true })).await;
    assert_eq!(r.json()["postReplies"], false);
    assert_eq!(r.json()["postHearts"], true);
    let (kai, _) = t.register("kai").await;
    heart_ok(&t, &kai, &p2, true).await;
    reply_id(&t, &kai, &p2, "z").await;
    assert_eq!(unread(&t, &mia).await, 1);
    assert_eq!(
        of_kind(&t, &mia, "postHeart").await[0]["postId"],
        p2.as_str()
    );

    // Other kinds have postId null.
    let r = all_items(&t, &mia).await;
    assert!(
        r.iter()
            .filter(|i| i["kind"] != "postReply" && i["kind"] != "postHeart")
            .all(|i| i["postId"].is_null())
    );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reply_reports() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let (boss, _) = t.register("boss").await;
    let pid = text_post(&t, &mia, "Post").await;
    let long = "x".repeat(200);
    let rid = reply_id(&t, &leo, &pid, &long).await;

    let r = report(&t, &kai, "postReply", &rid).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v = r.json();
    assert_eq!(v["targetType"], "postReply");
    assert_eq!(v["targetId"], rid.as_str());
    assert_eq!(v["targetPreview"], "x".repeat(140));
    assert_eq!(v["targetGameId"], Value::Null);
    assert_eq!(v["targetPostId"], pid.as_str());
    assert_eq!(v["targetImageUrl"], Value::Null);
    let first = s(&v["id"]);

    let pr = report(&t, &kai, "post", &pid).await.json();
    assert_eq!(pr["targetPostId"], pid.as_str());
    let ur = report(
        &t,
        &kai,
        "user",
        &s(&get_post(&t, None, &pid).await["author"]["id"]),
    )
    .await;
    assert_eq!(ur.status, StatusCode::CREATED);
    assert_eq!(ur.json()["targetPostId"], Value::Null);

    assert_eq!(
        report(&t, &kai, "postReply", &rid).await.status,
        StatusCode::CONFLICT
    );
    assert_422(
        &report(&t, &leo, "postReply", &rid).await,
        "You can't report your own reply",
    );
    assert_404(
        &report(&t, &kai, "postReply", "nope").await,
        "Reply not found",
    );
    assert_422(
        &report(&t, &kai, "thing", &rid).await,
        "targetType must be \"game\", \"comment\", \"screenshot\", \"collection\", \"user\", \"post\" or \"postReply\"",
    );

    // The admin list carries targetPostId.
    let r = t.get("/api/admin/reports?status=open", Some(&boss)).await;
    assert_eq!(r.status, StatusCode::OK);
    let items = r.json()["items"].as_array().unwrap().clone();
    let listed = items.iter().find(|i| i["id"] == first.as_str()).unwrap();
    assert_eq!(listed["targetPostId"], pid.as_str());

    assert_422(
        &resolve(&t, &boss, &first, "unpublish").await,
        "unpublish is only valid for game reports",
    );
    assert_422(
        &resolve(&t, &boss, &first, "clearProfile").await,
        "clearProfile is only valid for user reports",
    );
    let second = s(&report(&t, &mia, "postReply", &rid).await.json()["id"]);
    let r = resolve(&t, &boss, &first, "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["resolution"], "delete");
    assert_eq!(
        count(&t, "SELECT COUNT(*) FROM post_replies WHERE id = ?", &rid).await,
        0
    );
    assert_eq!(
        report_state(&t, &second).await,
        ("resolved".into(), Some("delete".into()))
    );
    assert_eq!(get_post(&t, None, &pid).await["replyCount"], 0);

    // Dismiss on another reply; delete on a reply that's already gone is not an error.
    let r2 = reply_id(&t, &leo, &pid, "again").await;
    let d = s(&report(&t, &kai, "postReply", &r2).await.json()["id"]);
    assert_eq!(
        resolve(&t, &boss, &d, "dismiss").await.status,
        StatusCode::OK
    );
    assert_eq!(
        count(&t, "SELECT COUNT(*) FROM post_replies WHERE id = ?", &r2).await,
        1
    );
    let e = s(&report(&t, &mia, "postReply", &r2).await.json()["id"]);
    assert_eq!(
        del_reply(&t, Some(&leo), &r2).await.status,
        StatusCode::NO_CONTENT
    );
    // The reply delete already resolved it.
    assert_eq!(
        report_state(&t, &e).await,
        ("resolved".into(), Some("delete".into()))
    );
    let r3 = reply_id(&t, &leo, &pid, "third").await;
    let f = s(&report(&t, &kai, "postReply", &r3).await.json()["id"]);
    sqlx::query("DELETE FROM post_replies WHERE id = ?")
        .bind(&r3)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(
        resolve(&t, &boss, &f, "delete").await.status,
        StatusCode::OK
    );
}

// ---------------------------------------------------------------------------
// Review 11 carry-over
// ---------------------------------------------------------------------------

async fn profile_row(t: &TestApp, uid: &str) -> (String, String, String) {
    sqlx::query_as("SELECT display_name, bio, links_json FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn patch_me(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::PATCH, "/api/users/me", Some(tok), body)
        .await
}

#[tokio::test]
async fn review11_forbidden_characters() {
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    let r = patch_me(
        &t,
        &mia,
        json!({ "displayName": "Mia", "bio": "Hi", "links": [{ "label": "Site", "url": "https://x.com" }] }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let before = profile_row(&t, &mia_id).await;

    for c in REVIEW11 {
        let hex = format!("U+{:04X}", c as u32);
        assert_422(
            &t.json(
                Method::POST,
                "/api/posts",
                Some(&mia),
                json!({ "body": format!("a{c}b") }),
            )
            .await,
            "body must be plain text",
        );
        assert_422(
            &patch_me(
                &t,
                &mia,
                json!({ "links": [{ "label": format!("a{c}b"), "url": "https://x.com" }] }),
            )
            .await,
            "links[0].label must not contain control characters",
        );
        assert_422(
            &patch_me(&t, &mia, json!({ "displayName": format!("Mi{c}a") })).await,
            "displayName must not contain control characters",
        );
        assert_422(
            &patch_me(&t, &mia, json!({ "bio": format!("a{c}b") })).await,
            "bio must not contain control characters",
        );
        // Validate before write: a valid displayName with a bad bio changes nothing.
        assert_422(
            &patch_me(
                &t,
                &mia,
                json!({ "displayName": "Changed", "bio": format!("x{c}y"), "links": [] }),
            )
            .await,
            "bio must not contain control characters",
        );
        assert_422(
            &patch_me(
                &t,
                &mia,
                json!({ "displayName": "Changed", "bio": "fine", "links": [{ "label": format!("a{c}b"), "url": "https://x.com" }] }),
            )
            .await,
            "links[0].label must not contain control characters",
        );
        assert_eq!(profile_row(&t, &mia_id).await, before, "{hex}");
    }
    assert_eq!(
        count(
            &t,
            "SELECT COUNT(*) FROM posts WHERE author_id = ?",
            &mia_id
        )
        .await,
        0
    );

    // displayName with "\n" → 422; bio "\n" allowed and CRLF normalised.
    assert_422(
        &patch_me(&t, &mia, json!({ "displayName": "Mi\na" })).await,
        "displayName must not contain control characters",
    );
    // displayName is checked before bio.
    assert_422(
        &patch_me(
            &t,
            &mia,
            json!({ "displayName": "Mi\u{2028}a", "bio": "\u{2028}" }),
        )
        .await,
        "displayName must not contain control characters",
    );
    let r = patch_me(&t, &mia, json!({ "bio": "a\r\nb" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bio"], "a\nb");
    assert_eq!(profile_row(&t, &mia_id).await.1, "a\nb");
    let r = patch_me(&t, &mia, json!({ "bio": " line1\nline2\rline3 " })).await;
    assert_eq!(r.json()["bio"], "line1\nline2\nline3");
    // Trim runs first: U+2028 / U+2029 are Unicode whitespace, so at either end they go.
    let r = patch_me(&t, &mia, json!({ "bio": "\u{2029}bio\u{2028}" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["bio"], "bio");

    // Stored values from before the change are returned as they are.
    sqlx::query("UPDATE users SET display_name = 'Old\u{2028}Name' WHERE id = ?")
        .bind(&mia_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.get("/api/auth/me", Some(&mia)).await;
    assert_eq!(r.json()["displayName"], "Old\u{2028}Name");
}

#[tokio::test]
async fn review11_banner_race_is_a_conflict() {
    use webgame_server::routes::users::{BANNER_CHANGED, store_banner};
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    let file = t.state.storage.banners_dir().join(format!("{mia_id}.jpg"));
    let version = |t: &TestApp| {
        let db = t.state.db.clone();
        let id = mia_id.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT banner_version FROM users WHERE id = ?")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap()
        }
    };

    // Uncontended: stored, version + 1, bannerUrl points at the file.
    let v0 = version(&t).await;
    store_banner(&t.state, &mia_id, v0, b"jpeg-1")
        .await
        .unwrap();
    assert_eq!(version(&t).await, v0 + 1);
    assert!(file.exists());
    let me = t.get("/api/auth/me", Some(&mia)).await.json();
    assert_eq!(
        me["bannerUrl"],
        format!("/media/banners/{mia_id}.jpg?v={}", v0 + 1)
    );

    // A clear (DELETE /api/users/me/banner) wins between the read and the final write.
    let stale = version(&t).await;
    let r = empty(&t, Method::DELETE, "/api/users/me/banner", Some(&mia)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let err = store_banner(&t.state, &mia_id, stale, b"jpeg-2")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    assert_eq!(err.code(), "conflict");
    assert_eq!(err.to_string(), BANNER_CHANGED);
    assert_eq!(
        BANNER_CHANGED,
        "Your banner changed while uploading; try again"
    );
    let me = t.get("/api/auth/me", Some(&mia)).await.json();
    assert_eq!(me["bannerUrl"], Value::Null);
    assert!(
        !file.exists(),
        "the file written by the losing upload is removed"
    );

    // Another upload wins: the row keeps pointing at an existing file.
    let stale = version(&t).await;
    store_banner(&t.state, &mia_id, stale, b"winner")
        .await
        .unwrap();
    let err = store_banner(&t.state, &mia_id, stale, b"loser")
        .await
        .unwrap_err();
    assert_eq!(err.status(), StatusCode::CONFLICT);
    let me = t.get("/api/auth/me", Some(&mia)).await.json();
    assert!(me["bannerUrl"].is_string());
    assert!(file.exists());
}
