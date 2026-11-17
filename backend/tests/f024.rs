//! F024: "screenshot of your game" notifications for creators (API.md § F024 additions).

mod common;

use std::io::Cursor;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn shot_png() -> Vec<u8> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(64, 64, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

async fn game(t: &TestApp, tok: &str, title: &str, published: bool) -> String {
    t.create_game(tok, title, "", published).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn post(t: &TestApp, tok: &str, gid: &str, img: &[u8]) -> Resp {
    t.multipart(
        Method::POST,
        &format!("/api/games/{gid}/screenshots"),
        Some(tok),
        &[
            Part::File("image", "shot.png", "image/png", img),
            Part::Text("caption", "secret caption text"),
        ],
    )
    .await
}

/// Post a valid screenshot; returns the 201 `Screenshot` JSON.
async fn shoot(t: &TestApp, tok: &str, gid: &str) -> Value {
    let r = post(t, tok, gid, &shot_png()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn send_empty(t: &TestApp, method: Method, uri: &str, tok: &str) -> Resp {
    t.send(method, uri, Some(tok), None, vec![], &[]).await
}

async fn delete_shot(t: &TestApp, tok: &str, id: &str) {
    let r = send_empty(t, Method::DELETE, &format!("/api/screenshots/{id}"), tok).await;
    assert!(r.status.is_success(), "{} {}", r.status, r.text());
}

/// Every listed notification of the caller.
async fn all_items(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

/// The caller's listed `screenshotPosted` notifications, newest first.
async fn shots(t: &TestApp, tok: &str) -> Vec<Value> {
    all_items(t, tok)
        .await
        .into_iter()
        .filter(|i| i["kind"] == "screenshotPosted")
        .collect()
}

async fn unread(t: &TestApp, tok: &str) -> i64 {
    let r = t.get("/api/notifications/unread-count", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["unread"].as_i64().unwrap()
}

async fn mark_all(t: &TestApp, tok: &str, up_to: &Value) {
    let r = t
        .json(
            Method::POST,
            "/api/notifications/read",
            Some(tok),
            json!({ "upTo": up_to }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn put_settings(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::PUT, "/api/notifications/settings", Some(tok), body)
        .await
}

/// Stored `screenshotPosted` notifications (any recipient, read or unread).
async fn stored_notifs(t: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE kind = 'screenshotPosted'")
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

/// Stored events that carry a screenshot.
async fn stored_shot_events(t: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM notification_events WHERE screenshot_id IS NOT NULL")
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

fn usernames(actors: &Value) -> Vec<String> {
    actors
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["username"].as_str().unwrap().to_string())
        .collect()
}

fn sid(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_upgrade_from_0022() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let dir = common::test_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        data.join("webgame.db").to_string_lossy().replace('\\', "/")
    );
    type EventRow = (i64, i64, String, Option<String>, String, Option<String>);
    const EVENT_ROWS: &str = "SELECT id, notification_id, actor_id, comment_id, created_at, \
         retracted_at FROM notification_events ORDER BY id";
    let events_before: Vec<EventRow> = {
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
                .filter(|x| x.version <= 22)
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
                "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, \
                 updated_at, actions_json, controls_hint, published) VALUES \
                 ('g1', 'u1', 'Old', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '', 1)"
            ),
            format!(
                "INSERT INTO screenshots (id, game_id, author_id, caption, ext, width, height, \
                 bytes, game_version, created_at) VALUES \
                 ('s1', 'g1', 'u2', '', 'png', 64, 64, 10, 1, '{ts}')"
            ),
            format!(
                "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) VALUES \
                 ('c1', 'g1', 'u2', 'one', '{ts}', NULL), ('c2', 'g1', 'u2', 'two', '{ts}', NULL)"
            ),
            format!(
                "INSERT INTO notifications (id, recipient_id, kind, group_key, game_id, \
                 comment_id, read_at, created_at, updated_at) VALUES \
                 (7, 'u1', 'comment', 'game:g1', 'g1', NULL, NULL, '{ts}', '{ts}')"
            ),
            format!(
                "INSERT INTO notification_events (id, notification_id, actor_id, comment_id, \
                 created_at, retracted_at) VALUES \
                 (1, 7, 'u2', 'c1', '{ts}', NULL), (2, 7, 'u2', 'c2', '{ts}', NULL)"
            ),
            format!(
                "INSERT INTO notification_settings (user_id, comments, replies, hearts, follows, \
                 new_games, updated_at) VALUES ('u1', 1, 0, 1, 0, 1, '{ts}')"
            ),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        let events: Vec<EventRow> = sqlx::query_as(EVENT_ROWS).fetch_all(&db).await.unwrap();
        db.close().await;
        events
    };
    assert_eq!(events_before.len(), 2);

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    // Existing events unchanged, with no screenshot.
    let events: Vec<EventRow> = sqlx::query_as(EVENT_ROWS).fetch_all(&db).await.unwrap();
    assert_eq!(events, events_before);
    let with_shot: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_events WHERE screenshot_id IS NOT NULL",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(with_shot, 0);

    // The new setting defaults to on for the existing row.
    let screenshots: i64 =
        sqlx::query_scalar("SELECT screenshots FROM notification_settings WHERE user_id = 'u1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(screenshots, 1);

    // Indexes and the 0014 trigger.
    let dedupe: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'index' \
         AND name = 'idx_notification_events_dedupe'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(dedupe.contains("IFNULL(screenshot_id, '')"), "{dedupe}");
    let shot_idx: String = sqlx::query_scalar(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' \
         AND name = 'idx_notification_events_screenshot'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(shot_idx, "notification_events");
    let trigger: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' \
         AND name = 'notification_events_last_gone'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(trigger, 1);

    // Consistency.
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

    // One event per screenshot: same (notification, actor), NULL comment, two screenshots.
    sqlx::query(
        "INSERT INTO screenshots (id, game_id, author_id, caption, ext, width, height, bytes, \
         game_version, created_at) VALUES \
         ('s2', 'g1', 'u2', '', 'png', 64, 64, 10, 1, '2026-01-02T00:00:00.000Z')",
    )
    .execute(&db)
    .await
    .unwrap();
    let insert = "INSERT OR IGNORE INTO notification_events (notification_id, actor_id, \
         comment_id, screenshot_id, created_at) VALUES (7, 'u2', NULL, ?, \
         '2026-01-02T00:00:00.000Z')";
    for s in ["s1", "s2"] {
        let n = sqlx::query(insert)
            .bind(s)
            .execute(&db)
            .await
            .unwrap()
            .rows_affected();
        assert_eq!(n, 1, "{s}");
    }
    let again = sqlx::query(insert)
        .bind("s1")
        .execute(&db)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(again, 0);
}

// ---------------------------------------------------------------------------
// Write and read paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn basic_notification_payload() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;

    let shot = shoot(&t, &player, &gid).await;
    let id = sid(&shot);

    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1, "{l:?}");
    let n = &l[0];
    assert_eq!(usernames(&n["actors"]), vec!["pia"]);
    assert_eq!(n["actorCount"], 1);
    assert_eq!(n["eventCount"], 1);
    assert_eq!(n["game"]["id"], gid.as_str());
    assert_eq!(n["game"]["title"], "Space Dodge");
    assert_eq!(
        n["screenshot"],
        json!({ "id": id, "thumbUrl": format!("/media/screenshots/{id}_t.jpg") })
    );
    assert_eq!(n["path"], format!("/games/{gid}?section=screenshots"));
    assert!(n["commentId"].is_null());
    assert!(n["excerpt"].is_null());
    assert!(n["threadId"].is_null());
    assert!(n["collection"].is_null());
    assert_eq!(n["ownsThread"], false);
    assert_eq!(n["creatorHeart"], false);
    assert_eq!(n["read"], false);
    assert_eq!(n["createdAt"], shot["createdAt"]);
    assert_eq!(n["updatedAt"], shot["createdAt"]);
    // The caption never reaches the notification.
    assert!(!n.to_string().contains("secret caption"));

    assert_eq!(unread(&t, &owner).await, 1);
    assert!(all_items(&t, &player).await.is_empty());
    assert_eq!(unread(&t, &player).await, 0);

    // Other kinds carry `screenshot: null`.
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&player),
            json!({ "body": "nice" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let all = all_items(&t, &owner).await;
    let c = all.iter().find(|i| i["kind"] == "comment").unwrap();
    assert!(c.get("screenshot").is_some_and(Value::is_null), "{c}");
}

#[tokio::test]
async fn coalescing_and_new_group_after_read() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let (third, _) = t.register("quin").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;

    let first = shoot(&t, &player, &gid).await;
    let id1 = shots(&t, &owner).await[0]["id"].clone();
    let second = shoot(&t, &player, &gid).await;
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["id"], id1);
    assert_eq!(l[0]["eventCount"], 2);
    assert_eq!(l[0]["actorCount"], 1);
    assert_eq!(l[0]["createdAt"], first["createdAt"]);
    assert_eq!(l[0]["updatedAt"], second["createdAt"]);
    assert_eq!(l[0]["screenshot"]["id"], second["id"]);

    let q = shoot(&t, &third, &gid).await;
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["id"], id1);
    assert_eq!(usernames(&l[0]["actors"]), vec!["quin", "pia"]);
    assert_eq!(l[0]["actorCount"], 2);
    assert_eq!(l[0]["eventCount"], 3);
    assert_eq!(l[0]["screenshot"]["id"], q["id"]);
    assert_eq!(unread(&t, &owner).await, 1);

    // Read → the next post opens a new notification; the read one is unchanged.
    mark_all(&t, &owner, &l[0]["updatedAt"]).await;
    let read_before = shots(&t, &owner).await[0].clone();
    assert_eq!(read_before["read"], true);
    let fourth = shoot(&t, &player, &gid).await;
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 2);
    assert_ne!(l[0]["id"], id1);
    assert_eq!(l[0]["eventCount"], 1);
    assert_eq!(l[0]["actorCount"], 1);
    assert_eq!(l[0]["read"], false);
    assert_eq!(l[0]["screenshot"]["id"], fourth["id"]);
    assert_eq!(l[1], read_before);
    assert_eq!(unread(&t, &owner).await, 1);
}

#[tokio::test]
async fn own_and_unpublished_games_write_nothing() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let hidden = game(&t, &owner, "Draft", false).await;
    shoot(&t, &owner, &gid).await;
    shoot(&t, &owner, &hidden).await;
    assert_eq!(stored_notifs(&t).await, 0);
    assert_eq!(stored_shot_events(&t).await, 0);
    assert_eq!(unread(&t, &owner).await, 0);
}

#[tokio::test]
async fn deleting_screenshots_updates_and_removes_notifications() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;

    // Unread: the author deletes the newest of two, then the owner deletes the other.
    let a = shoot(&t, &player, &gid).await;
    let b = shoot(&t, &player, &gid).await;
    delete_shot(&t, &player, &sid(&b)).await;
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["eventCount"], 1);
    assert_eq!(l[0]["actorCount"], 1);
    assert_eq!(l[0]["screenshot"]["id"], a["id"]);
    delete_shot(&t, &owner, &sid(&a)).await;
    assert!(shots(&t, &owner).await.is_empty());
    assert_eq!(unread(&t, &owner).await, 0);
    assert_eq!(stored_notifs(&t).await, 0);

    // Read: deleting its only screenshot removes it too.
    let c = shoot(&t, &player, &gid).await;
    let l = shots(&t, &owner).await;
    mark_all(&t, &owner, &l[0]["updatedAt"]).await;
    assert_eq!(shots(&t, &owner).await[0]["read"], true);
    delete_shot(&t, &player, &sid(&c)).await;
    assert!(shots(&t, &owner).await.is_empty());
    assert_eq!(stored_notifs(&t).await, 0);

    // Deleting the game removes its notifications.
    shoot(&t, &player, &gid).await;
    shoot(&t, &player, &gid).await;
    assert_eq!(stored_notifs(&t).await, 1);
    let r = send_empty(&t, Method::DELETE, &format!("/api/games/{gid}"), &owner).await;
    assert!(r.status.is_success(), "{} {}", r.status, r.text());
    assert_eq!(stored_notifs(&t).await, 0);
    assert_eq!(stored_shot_events(&t).await, 0);
    assert_eq!(unread(&t, &owner).await, 0);
}

#[tokio::test]
async fn rejected_posts_write_nothing() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, player_id) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;

    // Not a decodable PNG/JPEG.
    let r = post(&t, &player, &gid, &png_bytes()).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    let r = post(&t, &player, &gid, b"GIF89a not an accepted image").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(stored_notifs(&t).await, 0);
    assert_eq!(stored_shot_events(&t).await, 0);

    // The 21st screenshot of the player on the game.
    for i in 0..20 {
        sqlx::query(
            "INSERT INTO screenshots (id, game_id, author_id, caption, ext, width, height, \
             bytes, game_version, created_at) VALUES (?, ?, ?, '', 'png', 64, 64, 10, 1, \
             '2026-01-01T00:00:00.000Z')",
        )
        .bind(format!("pre-{i}"))
        .bind(&gid)
        .bind(&player_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let r = post(&t, &player, &gid, &shot_png()).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(stored_notifs(&t).await, 0);
    assert_eq!(stored_shot_events(&t).await, 0);
    assert_eq!(unread(&t, &owner).await, 0);
}

#[tokio::test]
async fn rate_limited_post_writes_no_event() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    for _ in 0..10 {
        shoot(&t, &player, &gid).await;
    }
    assert_eq!(stored_shot_events(&t).await, 10);
    let r = post(&t, &player, &gid, &shot_png()).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(stored_shot_events(&t).await, 10);
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["eventCount"], 10);

    // One token refills after 360 s.
    t.clock.advance(std::time::Duration::from_secs(360));
    shoot(&t, &player, &gid).await;
    assert_eq!(stored_shot_events(&t).await, 11);
}

#[tokio::test]
async fn settings_switch() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;

    let r = t.get("/api/notifications/settings", Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["screenshots"], true);

    let r = put_settings(&t, &owner, json!({ "screenshots": false })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["screenshots"], false);
    // Other settings are untouched.
    assert_eq!(r.json()["comments"], true);
    shoot(&t, &player, &gid).await;
    assert_eq!(stored_notifs(&t).await, 0);
    assert_eq!(stored_shot_events(&t).await, 0);

    let r = put_settings(&t, &owner, json!({ "screenshots": true })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["screenshots"], true);
    shoot(&t, &player, &gid).await;
    assert_eq!(shots(&t, &owner).await.len(), 1);

    let r = put_settings(&t, &owner, json!({ "screenshots": "no" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    assert_eq!(
        r.json()["error"]["message"],
        "screenshots must be a boolean"
    );
    let r = t.get("/api/notifications/settings", Some(&owner)).await;
    assert_eq!(r.json()["screenshots"], true);
}

#[tokio::test]
async fn game_mutes_apply_thread_mutes_do_not() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, _) = t.register("pia").await;
    let muted = game(&t, &owner, "Muted", true).await;
    let later = game(&t, &owner, "Later", true).await;
    let threaded = game(&t, &owner, "Threaded", true).await;

    // A game mute suppresses the kind.
    let r = send_empty(
        &t,
        Method::PUT,
        &format!("/api/notifications/mutes/games/{muted}"),
        &owner,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    shoot(&t, &player, &muted).await;
    assert_eq!(stored_notifs(&t).await, 0);

    // Muting a game marks its unread notification read.
    shoot(&t, &player, &later).await;
    assert_eq!(unread(&t, &owner).await, 1);
    let r = send_empty(
        &t,
        Method::PUT,
        &format!("/api/notifications/mutes/games/{later}"),
        &owner,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(unread(&t, &owner).await, 0);
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["read"], true);

    // A thread mute on the game doesn't apply.
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{threaded}/comments"),
            Some(&owner),
            json!({ "body": "top level" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let cid = sid(&r.json());
    let r = send_empty(
        &t,
        Method::PUT,
        &format!("/api/notifications/mutes/threads/{cid}"),
        &owner,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    shoot(&t, &player, &threaded).await;
    let l = shots(&t, &owner).await;
    assert_eq!(l.len(), 2);
    assert_eq!(l[0]["game"]["id"], threaded.as_str());
    assert_eq!(l[0]["read"], false);
    assert_eq!(unread(&t, &owner).await, 1);
}

#[tokio::test]
async fn feed_event_still_written() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (player, player_id) = t.register("pia").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    shoot(&t, &player, &gid).await;
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM activity_events WHERE kind = 'screenshotPosted' \
         AND actor_id = ? AND game_id = ?",
    )
    .bind(&player_id)
    .bind(&gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(n, 1);
    assert_eq!(shots(&t, &owner).await.len(), 1);
}
