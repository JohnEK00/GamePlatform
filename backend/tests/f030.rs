//! F030: user posts (`POST /api/posts`, `GET`/`DELETE /api/posts/{id}`,
//! `GET /api/users/{username}/posts`), the `postCreated` feed kind, `post` reports,
//! `stats.posts` and the 0025 rebuild of `activity_events`.

mod common;

use std::io::Cursor;
use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
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

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
}

async fn post(t: &TestApp, tok: Option<&str>, body: Value) -> Resp {
    t.json(Method::POST, "/api/posts", tok, body).await
}

async fn post_ok(t: &TestApp, tok: &str, body: Value) -> Value {
    let r = post(t, Some(tok), body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn text_post(t: &TestApp, tok: &str, text: &str) -> String {
    s(&post_ok(t, tok, json!({ "body": text })).await["id"])
}

async fn get_post(t: &TestApp, tok: Option<&str>, id: &str) -> Resp {
    t.get(&format!("/api/posts/{id}"), tok).await
}

async fn delete_post(t: &TestApp, tok: Option<&str>, id: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/posts/{id}"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn game(t: &TestApp, tok: &str, title: &str, published: bool) -> String {
    s(&t.create_game(tok, title, "", published).await["id"])
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

async fn collection(t: &TestApp, tok: &str, title: &str, visibility: &str) -> String {
    let r = t
        .json(
            Method::POST,
            "/api/collections",
            Some(tok),
            json!({ "title": title, "visibility": visibility }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    s(&r.json()["id"])
}

async fn set_visibility(t: &TestApp, tok: &str, cid: &str, visibility: &str) {
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/collections/{cid}"),
            Some(tok),
            json!({ "visibility": visibility }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn empty(t: &TestApp, method: Method, uri: &str, tok: &str) -> Resp {
    t.send(method, uri, Some(tok), None, vec![], &[]).await
}

async fn follow(t: &TestApp, tok: &str, username: &str) {
    let r = empty(
        t,
        Method::PUT,
        &format!("/api/users/{username}/follow"),
        tok,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn feed_page(t: &TestApp, tok: &str, query: &str) -> Value {
    let r = t.get(&format!("/api/feed{query}"), Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn feed(t: &TestApp, tok: &str, query: &str) -> Vec<Value> {
    feed_page(t, tok, query).await["items"]
        .as_array()
        .unwrap()
        .clone()
}

fn kinds(items: &[Value]) -> Vec<String> {
    items.iter().map(|i| s(&i["kind"])).collect()
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

async fn scalar(t: &TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn report_state(t: &TestApp, id: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT status, resolution FROM reports WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

fn millis(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

/// One `activity_events` row as a JSON array of every pre-0025 column (ids included).
type ActivityRow = String;

const ACTIVITY_ROWS: &str = "SELECT json_array(id, actor_id, kind, game_id, version, score, \
     first_score, ach_id, ach_count, day, created_at, from_version, collection_id, game_ids) \
     FROM activity_events ORDER BY id";

#[tokio::test]
async fn migration_upgrade_from_0024() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let dir = common::test_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        data.join("webgame.db").to_string_lossy().replace('\\', "/")
    );
    let before: Vec<ActivityRow> = {
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
                .filter(|x| x.version <= 24)
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
                "INSERT INTO collections (id, owner_id, title, description, visibility, \
                 created_at, updated_at) VALUES ('col1', 'u1', 'Picks', '', 'public', '{ts}', \
                 '{ts}')"
            ),
            "INSERT INTO activity_events (id, actor_id, kind, game_id, version, score, \
             first_score, ach_id, ach_count, day, created_at, from_version, collection_id, \
             game_ids) VALUES \
             (3, 'u1', 'gamePublished', 'g1', 1, NULL, 0, NULL, 0, '2026-01-01', \
              '2026-01-01T00:00:00.000Z', NULL, NULL, NULL), \
             (7, 'u1', 'gameUpdated', 'g1', 3, NULL, 0, NULL, 0, '2026-01-02', \
              '2026-01-02T00:00:00.000Z', 2, NULL, NULL), \
             (8, 'u2', 'personalBest', 'g1', NULL, 50, 1, NULL, 0, '2026-01-03', \
              '2026-01-03T00:00:00.000Z', NULL, NULL, NULL), \
             (11, 'u1', 'collectionUpdated', NULL, NULL, NULL, 0, NULL, 0, '2026-01-04', \
              '2026-01-04T00:00:00.000Z', NULL, 'col1', '[\"g1\"]'), \
             (15, 'u2', 'achievementUnlocked', 'g1', NULL, NULL, 0, 'a1', 2, '2026-01-05', \
              '2026-01-05T00:00:00.000Z', NULL, NULL, NULL), \
             (40, 'u2', 'screenshotPosted', 'g1', NULL, NULL, 0, NULL, 0, '2026-01-06', \
              '2026-01-06T00:00:00.000Z', NULL, NULL, NULL)"
                .to_string(),
            // The sequence stays at 40 after its row is gone.
            "DELETE FROM activity_events WHERE id = 40".to_string(),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        let rows: Vec<ActivityRow> = sqlx::query_scalar(ACTIVITY_ROWS)
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(rows.len(), 5);
        let seq: i64 =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = 'activity_events'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(seq, 40);
        db.close().await;
        rows
    };

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    // 1. Every row with its id and columns; post_id NULL.
    let after: Vec<ActivityRow> = sqlx::query_scalar(ACTIVITY_ROWS)
        .fetch_all(&db)
        .await
        .unwrap();
    assert_eq!(before, after);
    let with_post: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM activity_events WHERE post_id IS NOT NULL")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(with_post, 0);

    // 2. Sequence carried over (one row, same value).
    let seq: Vec<(String, i64)> =
        sqlx::query_as("SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'activity_events%'")
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(seq, vec![("activity_events".to_string(), 40)]);

    // 3. Consistency and no leftovers.
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
    let leftovers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master \
         WHERE name LIKE '%activity_events_new%' OR sql LIKE '%activity_events_new%'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(leftovers, 0);
    let idx: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity_events' \
         AND sql IS NOT NULL ORDER BY name",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        idx,
        vec![
            "idx_activity_actor_id",
            "idx_activity_coalesce",
            "idx_activity_collection",
            "idx_activity_game_kind",
            "idx_activity_post"
        ]
    );

    // 4. The extended CHECK: all three targets NULL fails.
    let all_null = sqlx::query(
        "INSERT INTO activity_events (actor_id, kind, game_id, collection_id, post_id, day, \
         created_at) VALUES ('u1', 'postCreated', NULL, NULL, NULL, '2026-02-01', \
         '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await;
    assert!(all_null.is_err());

    // 5. A post event gets the next id after the old high-water mark and cascades.
    sqlx::query(
        "INSERT INTO posts (id, author_id, body, created_at) \
         VALUES ('p1', 'u1', 'hello', '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await
    .unwrap();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO activity_events (actor_id, kind, post_id, day, created_at) \
         VALUES ('u1', 'postCreated', 'p1', '2026-02-01', '2026-02-01T00:00:00.000Z') \
         RETURNING id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(id, 41);
    sqlx::query("DELETE FROM posts WHERE id = 'p1'")
        .execute(&db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_events WHERE id = 41")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);

    // 6. posts: at most one target column (the CHECK), SET NULL on target delete.
    let both = sqlx::query(
        "INSERT INTO posts (id, author_id, body, attachment_type, game_id, collection_id, \
         created_at) VALUES ('p2', 'u1', 'x', 'game', 'g1', 'col1', '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await;
    assert!(both.is_err());
    sqlx::query(
        "INSERT INTO posts (id, author_id, body, attachment_type, game_id, created_at) \
         VALUES ('p3', 'u1', 'x', 'game', 'g1', '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("DELETE FROM games WHERE id = 'g1'")
        .execute(&db)
        .await
        .unwrap();
    let (kind, gid): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT attachment_type, game_id FROM posts WHERE id = 'p3'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(kind.as_deref(), Some("game"));
    assert_eq!(gid, None);
    db.close().await;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_normalises_and_returns_the_post() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;
    let v = post_ok(&t, &tok, json!({ "body": "  hi\r\nthere  " })).await;
    let id = s(&v["id"]);
    assert_eq!(v["body"], "hi\nthere");
    assert_eq!(v["attachment"], Value::Null);
    assert_eq!(v["canDelete"], true);
    assert_eq!(v["path"], format!("/p/{id}"));
    assert_eq!(v["author"]["id"], uid);
    assert_eq!(v["author"]["username"], "mia");
    let created = s(&v["createdAt"]);
    assert!(created.ends_with('Z') && created.len() == 24, "{created}");
    // The stored body is the normalised text.
    let stored: String = sqlx::query_scalar("SELECT body FROM posts WHERE id = ?")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stored, "hi\nthere");
    // The event shares the post's created_at.
    let (kind, at, day): (String, String, String) = sqlx::query_as(
        "SELECT kind, created_at, day FROM activity_events WHERE post_id = ? \
         AND game_id IS NULL AND collection_id IS NULL",
    )
    .bind(&id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(kind, "postCreated");
    assert_eq!(at, created);
    assert_eq!(day, created[..10]);
}

#[tokio::test]
async fn body_rules_and_messages() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    let len = "body must be 1–500 characters";
    for (body, msg) in [
        (String::new(), len),
        ("   ".to_string(), len),
        ("é".repeat(501), len),
        (["l"; 13].join("\n"), "body must be at most 12 lines"),
        ("a\tb".to_string(), "body must be plain text"),
        ("a\u{202E}b".to_string(), "body must be plain text"),
        ("a\u{200B}b".to_string(), "body must be plain text"),
        ("a\u{7}b".to_string(), "body must be plain text"),
    ] {
        assert_422(&post(&t, Some(&tok), json!({ "body": body })).await, msg);
    }
    for ok in ["😀".repeat(500), "é".repeat(500), ["l"; 12].join("\r\n")] {
        let r = post(&t, Some(&tok), json!({ "body": ok })).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    }
    // Refused posts write nothing.
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM activity_events WHERE kind = ?",
            "postCreated"
        )
        .await,
        3
    );
}

#[tokio::test]
async fn request_shape_errors() {
    let t = setup().await;
    let (tok, _) = t.register("mia").await;
    let r = post(&t, None, json!({ "body": "hi" })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.text());
    for bad in [
        json!({}),
        json!({ "body": 5 }),
        json!({ "body": "hi", "gameId": 3 }),
        json!({ "body": "hi", "collectionId": true }),
        json!([]),
    ] {
        let r = post(&t, Some(&tok), bad.clone()).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{bad}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation");
    }
    let r = t
        .send(
            Method::POST,
            "/api/posts",
            Some(&tok),
            Some("application/json"),
            b"{\"body\":".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    assert_eq!(r.error_code(), "bad_request");
    // Unknown fields are ignored.
    let r = post(&t, Some(&tok), json!({ "body": "hi", "extra": 1 })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

#[tokio::test]
async fn attachment_rules() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let published = game(&t, &mia, "Pub", true).await;
    let own_draft = game(&t, &mia, "Draft", false).await;
    let leo_draft = game(&t, &leo, "Hidden", false).await;
    let leo_public = collection(&t, &leo, "Leo picks", "public").await;
    let leo_private = collection(&t, &leo, "Leo secret", "private").await;
    let own_private = collection(&t, &mia, "Mine", "private").await;

    let v = post_ok(&t, &mia, json!({ "body": "play", "gameId": published })).await;
    assert_eq!(v["attachment"]["type"], "game");
    assert_eq!(v["attachment"]["game"]["id"], published);
    assert_eq!(v["attachment"]["collection"], Value::Null);

    assert_422(
        &post(&t, Some(&mia), json!({ "body": "x", "gameId": own_draft })).await,
        "Only published games can be attached",
    );
    for gid in [leo_draft.as_str(), "nope", ""] {
        assert_err(
            &post(&t, Some(&mia), json!({ "body": "x", "gameId": gid })).await,
            StatusCode::NOT_FOUND,
            "not_found",
            "Game not found",
        );
    }

    // Anyone's public collection, even an empty one.
    let v = post_ok(
        &t,
        &mia,
        json!({ "body": "list", "collectionId": leo_public }),
    )
    .await;
    assert_eq!(v["attachment"]["type"], "collection");
    assert_eq!(v["attachment"]["game"], Value::Null);
    assert_eq!(v["attachment"]["collection"]["id"], leo_public);
    assert_eq!(v["attachment"]["collection"]["gameCount"], 0);
    assert_eq!(
        v["attachment"]["collection"]["path"],
        format!("/c/{leo_public}")
    );

    assert_422(
        &post(
            &t,
            Some(&mia),
            json!({ "body": "x", "collectionId": own_private }),
        )
        .await,
        "Only public collections can be attached",
    );
    for cid in [leo_private.as_str(), "nope"] {
        assert_err(
            &post(&t, Some(&mia), json!({ "body": "x", "collectionId": cid })).await,
            StatusCode::NOT_FOUND,
            "not_found",
            "Collection not found",
        );
    }

    // Both → 422 (before any lookup); nulls → none.
    assert_422(
        &post(
            &t,
            Some(&mia),
            json!({ "body": "x", "gameId": "nope", "collectionId": "nope" }),
        )
        .await,
        "A post can have at most one attachment",
    );
    let v = post_ok(
        &t,
        &mia,
        json!({ "body": "x", "gameId": null, "collectionId": null }),
    )
    .await;
    assert_eq!(v["attachment"], Value::Null);
    // The body rules come before the attachment rules.
    assert_422(
        &post(
            &t,
            Some(&mia),
            json!({ "body": "", "gameId": "a", "collectionId": "b" }),
        )
        .await,
        "body must be 1–500 characters",
    );
}

#[tokio::test]
async fn admin_can_attach_public_but_not_private_collections() {
    let t = admin_app().await;
    let (boss, _) = t.register("boss").await;
    let (leo, _) = t.register("leo").await;
    let private = collection(&t, &leo, "Secret", "private").await;
    assert_422(
        &post(
            &t,
            Some(&boss),
            json!({ "body": "x", "collectionId": private }),
        )
        .await,
        "Only public collections can be attached",
    );
}

#[tokio::test]
async fn attachments_resolve_for_the_viewer_at_read_time() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let gid = game(&t, &mia, "Pub", true).await;
    let cid = collection(&t, &mia, "Cozy", "public").await;
    let gp = s(&post_ok(&t, &mia, json!({ "body": "g", "gameId": gid })).await["id"]);
    let cp = s(&post_ok(&t, &mia, json!({ "body": "c", "collectionId": cid })).await["id"]);

    // Unpublished: hidden from others, visible to the owner.
    set_published(&t, &mia, &gid, false).await;
    let v = get_post(&t, None, &gp).await.json();
    assert_eq!(
        v["attachment"],
        json!({ "type": "game", "game": null, "collection": null })
    );
    let v = get_post(&t, Some(&mia), &gp).await.json();
    assert_eq!(v["attachment"]["game"]["id"], gid);

    // Private collection: hidden from others, visible to the owner.
    set_visibility(&t, &mia, &cid, "private").await;
    let v = get_post(&t, Some(&leo), &cp).await.json();
    assert_eq!(
        v["attachment"],
        json!({ "type": "collection", "game": null, "collection": null })
    );
    let v = get_post(&t, Some(&mia), &cp).await.json();
    assert_eq!(v["attachment"]["collection"]["id"], cid);

    // Deleted targets keep the type.
    let r = empty(&t, Method::DELETE, &format!("/api/games/{gid}"), &mia).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    let r = empty(&t, Method::DELETE, &format!("/api/collections/{cid}"), &mia).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    let v = get_post(&t, Some(&mia), &gp).await.json();
    assert_eq!(
        v["attachment"],
        json!({ "type": "game", "game": null, "collection": null })
    );
    let v = get_post(&t, Some(&mia), &cp).await.json();
    assert_eq!(
        v["attachment"],
        json!({ "type": "collection", "game": null, "collection": null })
    );
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_rate_limit_uses_its_own_bucket() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("mia").await;
    // A refused post (422) still uses a token: the limit is checked before validation.
    assert_422(
        &post(&t, Some(&tok), json!({ "body": "" })).await,
        "body must be 1–500 characters",
    );
    let mut ids = Vec::new();
    for i in 0..9 {
        ids.push(text_post(&t, &tok, &format!("post {i}")).await);
    }
    let r = post(&t, Some(&tok), json!({ "body": "eleventh" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());
    // Deleting doesn't refund a token; reads and deletes aren't limited.
    let r = delete_post(&t, Some(&tok), &ids[0]).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    let r = post(&t, Some(&tok), json!({ "body": "still no" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    for _ in 0..20 {
        assert_eq!(get_post(&t, None, &ids[1]).await.status, StatusCode::OK);
    }
    // Another user has their own bucket.
    let (leo, _) = t.register("leo").await;
    text_post(&t, &leo, "fine").await;
    // The bucket refills.
    t.clock.advance(Duration::from_secs(600));
    text_post(&t, &tok, "again").await;
}

#[tokio::test]
async fn at_most_25_posts_in_24_hours() {
    let t = setup().await; // RATE_LIMIT off; the 24-hour cap still applies
    let (tok, uid) = t.register("mia").await;
    let mut ids = Vec::new();
    for i in 0..25 {
        ids.push(text_post(&t, &tok, &format!("post {i}")).await);
    }
    let cap = "You can post at most 25 times in 24 hours";
    assert_422(&post(&t, Some(&tok), json!({ "body": "26" })).await, cap);
    // A refused post writes nothing.
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM posts WHERE author_id = ?", &uid).await,
        25
    );
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM activity_events WHERE actor_id = ?",
            &uid
        )
        .await,
        25
    );
    // Other users are unaffected.
    let (leo, _) = t.register("leo").await;
    text_post(&t, &leo, "hi").await;

    // A post exactly 24 h + 1 s old no longer counts (rolling, strictly later than now − 24 h).
    let old =
        millis(chrono::Utc::now() - chrono::Duration::hours(24) - chrono::Duration::seconds(1));
    sqlx::query("UPDATE posts SET created_at = ? WHERE id = ?")
        .bind(&old)
        .bind(&ids[0])
        .execute(&t.state.db)
        .await
        .unwrap();
    text_post(&t, &tok, "one more").await;
    assert_422(
        &post(&t, Some(&tok), json!({ "body": "full again" })).await,
        cap,
    );

    // API § F030: deleted posts no longer count toward the cap (the guarded insert counts
    // existing rows); only the `Limit::Post` token is never refunded.
    let r = delete_post(&t, Some(&tok), &ids[1]).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    text_post(&t, &tok, "after a delete").await;
    assert_422(&post(&t, Some(&tok), json!({ "body": "full" })).await, cap);
}

#[tokio::test]
async fn concurrent_posts_never_exceed_the_cap() {
    let t = setup().await;
    let (tok, uid) = t.register("mia").await;
    for i in 0..20 {
        text_post(&t, &tok, &format!("post {i}")).await;
    }
    let mut handles = Vec::new();
    for i in 0..10 {
        let router = t.router.clone();
        let tok = tok.clone();
        handles.push(tokio::spawn(async move {
            let req = axum::http::Request::builder()
                .method(Method::POST)
                .uri("/api/posts")
                .header("host", "localhost:8080")
                .header("authorization", format!("Bearer {tok}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    json!({ "body": format!("race {i}") }).to_string(),
                ))
                .unwrap();
            tower::ServiceExt::oneshot(router, req)
                .await
                .unwrap()
                .status()
        }));
    }
    let mut created = 0;
    for h in handles {
        let status = h.await.unwrap();
        if status == StatusCode::CREATED {
            created += 1;
        } else {
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
    assert_eq!(created, 5);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM posts WHERE author_id = ?", &uid).await,
        25
    );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_post_is_public() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (boss, _) = t.register("boss").await;
    let id = text_post(&t, &mia, "hello").await;
    let r = get_post(&t, None, &id).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["canDelete"], false);
    assert_eq!(v["body"], "hello");
    assert_eq!(
        get_post(&t, Some(&leo), &id).await.json()["canDelete"],
        false
    );
    assert_eq!(
        get_post(&t, Some(&mia), &id).await.json()["canDelete"],
        true
    );
    assert_eq!(
        get_post(&t, Some(&boss), &id).await.json()["canDelete"],
        true
    );
    assert_err(
        &get_post(&t, None, "nope").await,
        StatusCode::NOT_FOUND,
        "not_found",
        "Post not found",
    );
}

#[tokio::test]
async fn list_user_posts_order_and_paging() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (boss, _) = t.register("boss").await;
    let mut ids = Vec::new();
    for i in 0..23 {
        ids.push(text_post(&t, &mia, &format!("post {i}")).await);
    }
    // Pin the order: ids[0] oldest; ids[1] and ids[2] share a timestamp (then id asc).
    for (i, id) in ids.iter().enumerate() {
        let at = format!("2026-03-{:02}T00:00:00.000Z", (i + 1).min(28));
        sqlx::query("UPDATE posts SET created_at = ? WHERE id = ?")
            .bind(at)
            .bind(id)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE posts SET created_at = '2026-02-01T00:00:00.000Z' WHERE id IN (?, ?)")
        .bind(&ids[1])
        .bind(&ids[2])
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE posts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(&ids[0])
        .execute(&t.state.db)
        .await
        .unwrap();
    let mut want: Vec<String> = ids[3..].iter().rev().cloned().collect();
    let mut tie = vec![ids[1].clone(), ids[2].clone()];
    tie.sort();
    want.extend(tie);
    want.push(ids[0].clone());

    let r = t.get("/api/users/MIA/posts", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["total"], 23);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 20);
    let got: Vec<String> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| s(&p["id"]))
        .collect();
    assert_eq!(got, want[..20]);
    assert!(
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["canDelete"] == false)
    );

    let v = t
        .get("/api/users/mia/posts?page=2", Some(&mia))
        .await
        .json();
    let got: Vec<String> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| s(&p["id"]))
        .collect();
    assert_eq!(got, want[20..]);
    assert!(
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["canDelete"] == true)
    );
    let v = t.get("/api/users/mia/posts", Some(&boss)).await.json();
    assert!(
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["canDelete"] == true)
    );

    // perPage clamps to 1–50.
    let v = t.get("/api/users/mia/posts?perPage=0", None).await.json();
    assert_eq!(v["perPage"], 1);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    let v = t.get("/api/users/mia/posts?perPage=500", None).await.json();
    assert_eq!(v["perPage"], 50);
    assert_eq!(v["items"].as_array().unwrap().len(), 23);

    assert_err(
        &t.get("/api/users/mia/posts?page=x", None).await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "page must be an integer",
    );
    assert_err(
        &t.get("/api/users/mia/posts?perPage=x", None).await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "perPage must be an integer",
    );
    // The user is looked up before paging is parsed.
    assert_err(
        &t.get("/api/users/nobody/posts?page=x", None).await,
        StatusCode::NOT_FOUND,
        "not_found",
        "User not found",
    );
    // Empty list.
    let v = t.get("/api/users/boss/posts", None).await.json();
    assert_eq!(v["total"], 0);
    assert_eq!(v["items"], json!([]));
}

#[tokio::test]
async fn list_page_plan_uses_the_author_index() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    for i in 0..5 {
        text_post(&t, &mia, &format!("m{i}")).await;
        text_post(&t, &leo, &format!("l{i}")).await;
    }
    webgame_server::db::optimize(&t.state.db, true).await;
    sqlx::query("ANALYZE").execute(&t.state.db).await.unwrap();
    let sql = format!(
        "EXPLAIN QUERY PLAN {}",
        webgame_server::routes::posts::user_posts_page_sql()
    );
    let plan: Vec<String> = sqlx::query(&sql)
        .bind("author")
        .bind(20)
        .bind(0)
        .fetch_all(&t.state.db)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap())
        .collect();
    let text = plan.join("\n");
    assert!(text.contains("idx_posts_author_created"), "{text}");
    assert!(!text.contains("USE TEMP B-TREE"), "{text}");
}

#[tokio::test]
async fn stats_posts_matches_the_list_total() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    for i in 0..3 {
        text_post(&t, &mia, &format!("p{i}")).await;
    }
    for tok in [None, Some(mia.as_str())] {
        let v = t.get("/api/users/mia", tok).await.json();
        let list = t.get("/api/users/mia/posts", tok).await.json();
        assert_eq!(v["stats"]["posts"], 3);
        assert_eq!(v["stats"]["posts"], list["total"]);
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_by_author_or_admin() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (boss, _) = t.register("boss").await;
    let a = text_post(&t, &mia, "a").await;
    let b = text_post(&t, &mia, "b").await;
    let rep = report(&t, &leo, "post", &a).await;
    assert_eq!(rep.status, StatusCode::CREATED, "{}", rep.text());
    let rep = s(&rep.json()["id"]);

    assert_eq!(
        delete_post(&t, None, &a).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_err(
        &delete_post(&t, Some(&leo), &a).await,
        StatusCode::FORBIDDEN,
        "forbidden",
        "You do not have permission to do that",
    );
    assert_err(
        &delete_post(&t, Some(&leo), "nope").await,
        StatusCode::NOT_FOUND,
        "not_found",
        "Post not found",
    );
    let r = delete_post(&t, Some(&mia), &a).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert!(r.body.is_empty());
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM activity_events WHERE post_id = ?",
            &a
        )
        .await,
        0
    );
    assert_eq!(
        report_state(&t, &rep).await,
        ("resolved".to_string(), Some("delete".to_string()))
    );
    assert_eq!(
        delete_post(&t, Some(&mia), &a).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(get_post(&t, None, &a).await.status, StatusCode::NOT_FOUND);

    let r = delete_post(&t, Some(&boss), &b).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert_eq!(
        t.get("/api/users/mia", None).await.json()["stats"]["posts"],
        0
    );
}

#[tokio::test]
async fn deleting_the_author_deletes_posts_and_clear_profile_keeps_them() {
    let t = admin_app().await;
    let (mia, mia_id) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (boss, _) = t.register("boss").await;
    text_post(&t, &mia, "stays").await;
    // F028 clearProfile leaves posts in place.
    let r = report(&t, &leo, "user", &mia_id).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let r = resolve(&t, &boss, &s(&r.json()["id"]), "clearProfile").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM posts WHERE author_id = ?",
            &mia_id
        )
        .await,
        1
    );
    // Deleting the user cascades posts and their events.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&mia_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM posts WHERE author_id = ?",
            &mia_id
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM activity_events WHERE kind = ?",
            "postCreated"
        )
        .await,
        0
    );
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn feed_shows_posts_to_followers_only() {
    same_utc_day(feed_shows_posts_to_followers_only_body).await;
}

async fn feed_shows_posts_to_followers_only_body() {
    let t = setup().await;
    let (ana, ana_id) = t.register("ana").await;
    let (fay, _) = t.register("fay").await;
    let (nia, _) = t.register("nia").await;
    follow(&t, &fay, "ana").await;

    // ids in order: gamePublished, post 1, collectionUpdated, screenshotPosted, post 2.
    let gid = game(&t, &ana, "Ana Game", true).await;
    let r = empty(&t, Method::PUT, &format!("/api/games/{gid}/favorite"), &nia).await;
    assert!(r.status.is_success(), "{}", r.text());
    let p1 = post_ok(&t, &ana, json!({ "body": "first", "gameId": gid })).await;
    let cid = collection(&t, &ana, "Picks", "public").await;
    let r = empty(
        &t,
        Method::PUT,
        &format!("/api/collections/{cid}/games/{gid}"),
        &ana,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .multipart(
            Method::POST,
            &format!("/api/games/{gid}/screenshots"),
            Some(&ana),
            &[Part::File("image", "shot.png", "image/png", &png(64, 64))],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let p2 = post_ok(&t, &ana, json!({ "body": "second" })).await;

    // Everything: interleaved by id.
    let items = feed(&t, &fay, "").await;
    assert_eq!(
        kinds(&items),
        [
            "postCreated",
            "screenshotPosted",
            "collectionUpdated",
            "postCreated",
            "gamePublished"
        ]
    );
    let ids: Vec<i64> = items.iter().map(|i| s(&i["id"]).parse().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] > w[1]), "{ids:?}");
    let item = &items[0];
    assert_eq!(item["post"]["id"], p2["id"]);
    assert_eq!(item["post"]["body"], "second");
    assert_eq!(item["post"]["canDelete"], false);
    assert_eq!(item["game"], Value::Null);
    assert_eq!(item["reason"], "following");
    assert_eq!(item["actor"]["id"], ana_id);
    assert_eq!(item["createdAt"], p2["createdAt"]);
    for key in [
        "version",
        "score",
        "achievement",
        "update",
        "collection",
        "screenshots",
    ] {
        assert!(item.get(key).is_some_and(Value::is_null), "{key}: {item}");
    }
    assert_eq!(items[3]["post"]["attachment"]["game"]["id"], gid);
    // Other kinds: `post` null, `game` set (F021/F015 spot checks).
    for i in [&items[1], &items[2], &items[4]] {
        assert!(i.get("post").is_some_and(Value::is_null), "{i}");
        assert_eq!(i["game"]["id"], gid);
    }
    assert_eq!(items[1]["screenshots"]["count"], 1);
    assert_eq!(items[2]["collection"]["id"], cid);

    // kinds=postCreated: posts only.
    let items = feed(&t, &fay, "?kinds=postCreated").await;
    assert_eq!(kinds(&items), ["postCreated", "postCreated"]);
    assert_eq!(items[1]["post"]["id"], p1["id"]);

    // Never your own posts; never through favorites.
    assert!(!kinds(&feed(&t, &ana, "").await).contains(&"postCreated".to_string()));
    let nia_items = feed(&t, &nia, "").await;
    assert_eq!(kinds(&nia_items), ["gamePublished"]);
    assert_eq!(nia_items[0]["reason"], "favorite");

    // A delete removes the item.
    let r = delete_post(&t, Some(&ana), &s(&p2["id"])).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let items = feed(&t, &fay, "?kinds=postCreated").await;
    assert_eq!(kinds(&items), ["postCreated"]);
    assert_eq!(items[0]["post"]["id"], p1["id"]);
}

#[tokio::test]
async fn feed_cursor_pages_over_posts() {
    let t = setup().await;
    let (ana, _) = t.register("ana").await;
    let (fay, _) = t.register("fay").await;
    follow(&t, &fay, "ana").await;
    let mut posted = Vec::new();
    for i in 0..25 {
        posted.push(text_post(&t, &ana, &format!("post {i}")).await);
    }
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let q = match &cursor {
            Some(c) => format!("?limit=10&cursor={c}"),
            None => "?limit=10".to_string(),
        };
        let page = feed_page(&t, &fay, &q).await;
        pages += 1;
        for i in page["items"].as_array().unwrap() {
            assert_eq!(i["kind"], "postCreated");
            seen.push(s(&i["post"]["id"]));
        }
        match page["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
        assert!(pages < 10, "paging doesn't end");
    }
    assert_eq!(pages, 3);
    posted.reverse();
    assert_eq!(seen, posted);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_reports() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (pat, _) = t.register("pat").await;
    let (quinn, _) = t.register("quinn").await;
    let (boss, _) = t.register("boss").await;
    let body = format!("{}{}", "é".repeat(150), "tail");
    let id = text_post(&t, &mia, &body).await;

    let r = report(&t, &pat, "post", &id).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let v = r.json();
    assert_eq!(v["targetType"], "post");
    assert_eq!(v["targetId"], id);
    assert_eq!(v["targetPreview"], "é".repeat(140));
    assert_eq!(v["targetGameId"], Value::Null);
    assert_eq!(v["targetImageUrl"], Value::Null);
    assert_eq!(v["targetImageFullUrl"], Value::Null);
    let first = s(&v["id"]);

    assert_err(
        &report(&t, &pat, "post", &id).await,
        StatusCode::CONFLICT,
        "conflict",
        "You already have an open report on this item",
    );
    assert_422(
        &report(&t, &mia, "post", &id).await,
        "You can't report your own post",
    );
    assert_err(
        &report(&t, &pat, "post", "nope").await,
        StatusCode::NOT_FOUND,
        "not_found",
        "Post not found",
    );
    assert_422(
        &report(&t, &pat, "bogus", &id).await,
        "targetType must be \"game\", \"comment\", \"screenshot\", \"collection\", \"user\", \"post\" or \"postReply\"",
    );
    let r = report(&t, &quinn, "post", &id).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let second = s(&r.json()["id"]);

    assert_422(
        &resolve(&t, &boss, &first, "unpublish").await,
        "unpublish is only valid for game reports",
    );
    assert_422(
        &resolve(&t, &boss, &first, "clearProfile").await,
        "clearProfile is only valid for user reports",
    );
    let r = resolve(&t, &boss, &first, "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["status"], "resolved");
    assert_eq!(v["resolution"], "delete");
    assert_eq!(get_post(&t, None, &id).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        report_state(&t, &second).await,
        ("resolved".to_string(), Some("delete".to_string()))
    );
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM activity_events WHERE post_id = ?",
            &id
        )
        .await,
        0
    );

    // Dismiss leaves the post.
    let id2 = text_post(&t, &mia, "keep me").await;
    let r = report(&t, &pat, "post", &id2).await;
    let r = resolve(&t, &boss, &s(&r.json()["id"]), "dismiss").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(get_post(&t, None, &id2).await.status, StatusCode::OK);
}
