//! F021: collection activity: the `collectionUpdated` feed kind, the `addedToCollection`
//! notification kind, the `collections` setting and the 0019 rebuild of `activity_events`.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_string()
}

async fn game(t: &TestApp, tok: &str, title: &str, published: bool) -> String {
    s(&t.create_game(tok, title, "", published).await["id"])
}

async fn mk(t: &TestApp, tok: &str, title: &str, visibility: &str) -> String {
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

async fn put_item(t: &TestApp, tok: &str, cid: &str, gid: &str, body: Option<Value>) -> Resp {
    let uri = format!("/api/collections/{cid}/games/{gid}");
    match body {
        Some(b) => t.json(Method::PUT, &uri, Some(tok), b).await,
        None => {
            t.send(Method::PUT, &uri, Some(tok), None, vec![], &[])
                .await
        }
    }
}

async fn add(t: &TestApp, tok: &str, cid: &str, gid: &str) -> Value {
    let r = put_item(t, tok, cid, gid, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn add_note(t: &TestApp, tok: &str, cid: &str, gid: &str, note: &str) -> Value {
    let r = put_item(t, tok, cid, gid, Some(json!({ "note": note }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn remove(t: &TestApp, tok: &str, cid: &str, gid: &str) {
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/collections/{cid}/games/{gid}"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn patch_collection(t: &TestApp, tok: &str, cid: &str, body: Value) {
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/collections/{cid}"),
            Some(tok),
            body,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
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

async fn follow(t: &TestApp, tok: &str, username: &str) {
    let r = t
        .send(
            Method::PUT,
            &format!("/api/users/{username}/follow"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn feed(t: &TestApp, tok: &str, query: &str) -> Vec<Value> {
    let r = t.get(&format!("/api/feed{query}"), Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

/// The viewer's `collectionUpdated` items (all kinds requested).
async fn coll_items(t: &TestApp, tok: &str) -> Vec<Value> {
    feed(t, tok, "")
        .await
        .into_iter()
        .filter(|i| i["kind"] == "collectionUpdated")
        .collect()
}

fn game_ids(item: &Value) -> Vec<String> {
    item["collection"]["games"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| s(&g["game"]["id"]))
        .collect()
}

async fn notifs(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "addedToCollection")
        .cloned()
        .collect()
}

async fn unread(t: &TestApp, tok: &str) -> i64 {
    let r = t.get("/api/notifications/unread-count", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["unread"].as_i64().unwrap()
}

async fn mark_all_read(t: &TestApp, tok: &str) {
    let r = t
        .json(
            Method::POST,
            "/api/notifications/read",
            Some(tok),
            json!({ "upTo": "2999-01-01T00:00:00.000Z" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn scalar(t: &TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

/// Stored `collectionUpdated` rows of a collection.
async fn event_rows(t: &TestApp, cid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM activity_events WHERE collection_id = ? \
         AND kind = 'collectionUpdated'",
        cid,
    )
    .await
}

/// Stored `addedToCollection` rows of a collection.
async fn notif_rows(t: &TestApp, cid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM notifications WHERE collection_id = ? \
         AND kind = 'addedToCollection'",
        cid,
    )
    .await
}

async fn exec(t: &TestApp, sql: &str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(&t.state.db).await.unwrap();
}

/// Curator `cora` (followed by `finn`), creator `olga`, bystander `nina`.
struct World {
    t: TestApp,
    cora: String,
    cora_id: String,
    finn: String,
    olga: String,
    nina: String,
}

async fn world() -> World {
    world_with(|_| {}).await
}

async fn world_with(customize: impl FnOnce(&mut webgame_server::Config)) -> World {
    let t = setup_with(customize).await;
    let (cora, cora_id) = t.register("cora").await;
    let (finn, _) = t.register("finn").await;
    let (olga, _) = t.register("olga").await;
    let (nina, _) = t.register("nina").await;
    follow(&t, &finn, "cora").await;
    World {
        t,
        cora,
        cora_id,
        finn,
        olga,
        nina,
    }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

type ActivityRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<i64>,
    i64,
    Option<String>,
    i64,
    String,
    String,
    Option<i64>,
);
const ACTIVITY_ROWS: &str = "SELECT id, actor_id, kind, game_id, version, score, first_score, \
     ach_id, ach_count, day, created_at, from_version FROM activity_events ORDER BY id";

#[tokio::test]
async fn migration_upgrade_from_0018() {
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
                .filter(|x| x.version <= 18)
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
            // Every pre-F021 kind, with explicit ids and every kind-specific column.
            "INSERT INTO activity_events (id, actor_id, kind, game_id, version, score, \
             first_score, ach_id, ach_count, day, created_at, from_version) VALUES \
             (3, 'u1', 'gamePublished', 'g1', 1, NULL, 0, NULL, 0, '2026-01-01', \
              '2026-01-01T00:00:00.000Z', NULL), \
             (7, 'u1', 'gameUpdated', 'g1', 3, NULL, 0, NULL, 0, '2026-01-02', \
              '2026-01-02T00:00:00.000Z', 2), \
             (8, 'u2', 'personalBest', 'g1', NULL, 50, 1, NULL, 0, '2026-01-03', \
              '2026-01-03T00:00:00.000Z', NULL), \
             (15, 'u2', 'achievementUnlocked', 'g1', NULL, NULL, 0, 'a1', 2, '2026-01-04', \
              '2026-01-04T00:00:00.000Z', NULL), \
             (30, 'u2', 'personalBest', 'g1', NULL, 60, 0, NULL, 0, '2026-01-05', \
              '2026-01-05T00:00:00.000Z', NULL)"
                .to_string(),
            // The sequence stays at 30 after its row is gone.
            "DELETE FROM activity_events WHERE id = 30".to_string(),
            "INSERT INTO notifications (id, recipient_id, kind, group_key, game_id, comment_id, \
             read_at, created_at, updated_at) VALUES \
             (4, 'u1', 'follow', 'follow', NULL, NULL, NULL, '2026-01-04T00:00:00.000Z', \
              '2026-01-04T00:00:00.000Z')"
                .to_string(),
            "INSERT INTO notification_events (notification_id, actor_id, comment_id, \
             created_at) VALUES (4, 'u2', NULL, '2026-01-04T00:00:00.000Z')"
                .to_string(),
            "INSERT INTO notification_settings (user_id, comments, replies, hearts, follows, \
             new_games, pins, updated_at) VALUES ('u1', 1, 0, 1, 0, 1, 0, \
             '2026-01-06T00:00:00.000Z')"
                .to_string(),
            format!(
                "INSERT INTO collections (id, owner_id, title, description, visibility, \
                 created_at, updated_at) VALUES ('col1', 'u2', 'Picks', '', 'public', '{ts}', \
                 '{ts}')"
            ),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        let rows: Vec<ActivityRow> = sqlx::query_as(ACTIVITY_ROWS).fetch_all(&db).await.unwrap();
        assert_eq!(rows.len(), 4);
        let seq: i64 =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = 'activity_events'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(seq, 30);
        db.close().await;
        rows
    };

    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    // 1. Same rows, same columns; the new columns are NULL.
    let after: Vec<ActivityRow> = sqlx::query_as(ACTIVITY_ROWS).fetch_all(&db).await.unwrap();
    assert_eq!(before, after);
    let new_cols: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM activity_events \
         WHERE collection_id IS NOT NULL OR game_ids IS NOT NULL",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(new_cols, 0);

    // 2. Integrity, foreign keys, no leftovers.
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
    let seq_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_sequence WHERE name LIKE 'activity_events%'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(seq_rows, 1);

    // 3. No kind CHECK; collectionUpdated with a NULL game; the either-or CHECK.
    let table_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activity_events'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!table_sql.contains("CHECK (kind"), "{table_sql}");
    // 5. … and the next id continues after the old high-water mark.
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO activity_events (actor_id, kind, game_id, collection_id, game_ids, day, \
         created_at) VALUES ('u2', 'collectionUpdated', NULL, 'col1', '[\"g1\"]', \
         '2026-02-01', '2026-02-01T00:00:00.000Z') RETURNING id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(id, 31);
    let both_null = sqlx::query(
        "INSERT INTO activity_events (actor_id, kind, game_id, collection_id, day, created_at) \
         VALUES ('u2', 'collectionUpdated', NULL, NULL, '2026-02-01', \
         '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await;
    assert!(both_null.is_err());
    // An unknown kind is accepted by the database now (activity::KINDS is the guard).
    sqlx::query(
        "INSERT INTO activity_events (actor_id, kind, game_id, day, created_at) \
         VALUES ('u2', 'somethingNew', 'g1', '2026-02-01', '2026-02-01T00:00:00.000Z')",
    )
    .execute(&db)
    .await
    .unwrap();

    // 4. Exactly the four indexes.
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
            "idx_activity_game_kind"
        ]
    );

    // 6. The notification and settings columns.
    let cid: Option<String> =
        sqlx::query_scalar("SELECT collection_id FROM notifications WHERE id = 4")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(cid, None);
    let (pins, collections): (i64, i64) =
        sqlx::query_as("SELECT pins, collections FROM notification_settings WHERE user_id = 'u1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((pins, collections), (0, 1));

    // The collection delete cascades its feed rows.
    sqlx::query("DELETE FROM collections WHERE id = 'col1'")
        .execute(&db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_events WHERE id = 31")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    db.close().await;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn feed_item_coalesces_per_collection_and_day() {
    same_utc_day(feed_item_coalesces_per_collection_and_day_body).await;
}

/// The adds must share one UTC day, and `yesterday` is the day before it (L5: run through
/// `same_utc_day`).
async fn feed_item_coalesces_per_collection_and_day_body() {
    let w = world().await;
    let t = &w.t;
    let mut games = Vec::new();
    for i in 1..=6 {
        games.push(game(t, &w.olga, &format!("Game {i}"), true).await);
    }
    let cid = mk(t, &w.cora, "Cozy games", "public").await;
    add_note(t, &w.cora, &cid, &games[0], "First pick").await;
    add_note(t, &w.cora, &cid, &games[1], "").await;
    add_note(t, &w.cora, &cid, &games[2], "Third").await;

    let items = coll_items(t, &w.finn).await;
    assert_eq!(items.len(), 1, "{items:?}");
    let it = &items[0];
    assert_eq!(it["reason"], "following");
    assert_eq!(it["actor"]["username"], "cora");
    assert_eq!(it["collection"]["id"], cid.as_str());
    assert_eq!(it["collection"]["title"], "Cozy games");
    assert_eq!(it["collection"]["path"], format!("/c/{cid}"));
    assert_eq!(it["collection"]["gameCount"], 3);
    assert_eq!(
        game_ids(it),
        vec![games[2].clone(), games[1].clone(), games[0].clone()]
    );
    assert_eq!(it["collection"]["games"][0]["note"], "Third");
    assert_eq!(it["collection"]["games"][1]["note"], "");
    assert_eq!(it["collection"]["games"][2]["note"], "First pick");
    assert_eq!(it["game"]["id"], games[2].as_str());
    for k in ["version", "score", "achievement", "update"] {
        assert_eq!(it[k], Value::Null, "{k}");
    }
    let first_id: i64 = s(&it["id"]).parse().unwrap();
    assert_eq!(event_rows(t, &cid).await, 1);

    // A 4th and 5th add on the same day: still one item, moved up, 4 shown of 5.
    add(t, &w.cora, &cid, &games[3]).await;
    add(t, &w.cora, &cid, &games[4]).await;
    let items = coll_items(t, &w.finn).await;
    assert_eq!(items.len(), 1);
    let it = &items[0];
    let id: i64 = s(&it["id"]).parse().unwrap();
    assert!(id > first_id);
    assert_eq!(it["collection"]["gameCount"], 5);
    assert_eq!(
        game_ids(it),
        vec![
            games[4].clone(),
            games[3].clone(),
            games[2].clone(),
            games[1].clone()
        ]
    );
    assert_eq!(event_rows(t, &cid).await, 1);

    // kinds filters.
    let only = feed(t, &w.finn, "?kinds=collectionUpdated").await;
    assert_eq!(only.len(), 1);
    assert!(only.iter().all(|i| i["kind"] == "collectionUpdated"));
    let other = feed(t, &w.finn, "?kinds=gamePublished").await;
    assert!(other.iter().all(|i| i["kind"] != "collectionUpdated"));
    // Other kinds carry `collection: null`.
    follow(t, &w.finn, "olga").await;
    let all = feed(t, &w.finn, "").await;
    let published = all.iter().find(|i| i["kind"] == "gamePublished").unwrap();
    assert_eq!(published["collection"], Value::Null);
    // Non-followers and the curator don't see it.
    assert!(coll_items(t, &w.nina).await.is_empty());
    assert!(coll_items(t, &w.cora).await.is_empty());

    // An item of a previous day stays separate.
    let yesterday = chrono::Utc::now() - chrono::Duration::days(1);
    let y_day = yesterday.format("%Y-%m-%d").to_string();
    let y_ts = webgame_server::notifications::stamp(yesterday);
    add(t, &w.cora, &cid, &games[5]).await;
    exec(
        t,
        "UPDATE collection_games SET added_at = ? WHERE collection_id = ? AND game_id = ?",
        &[&y_ts, &cid, &games[5]],
    )
    .await;
    exec(
        t,
        "INSERT INTO activity_events (actor_id, kind, game_id, collection_id, game_ids, day, \
         created_at) VALUES (?, 'collectionUpdated', NULL, ?, ?, ?, ?)",
        &[
            &w.cora_id,
            &cid,
            &json!([games[5]]).to_string(),
            &y_day,
            &y_ts,
        ],
    )
    .await;
    let items = coll_items(t, &w.finn).await;
    assert_eq!(items.len(), 2, "{items:?}");
    let yday = items
        .iter()
        .find(|i| i["collection"]["gameCount"] == 1)
        .unwrap();
    assert_eq!(game_ids(yday), vec![games[5].clone()]);
    let today = items
        .iter()
        .find(|i| i["collection"]["gameCount"] == 5)
        .unwrap();
    assert!(!game_ids(today).contains(&games[5]));

    // Removed and re-added on a later day: only the later day's item lists it.
    remove(t, &w.cora, &cid, &games[5]).await;
    add(t, &w.cora, &cid, &games[5]).await;
    let items = coll_items(t, &w.finn).await;
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(items[0]["collection"]["gameCount"], 6);
    assert_eq!(game_ids(&items[0])[0], games[5]);
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

#[tokio::test]
async fn private_collections_never_produce_activity() {
    let w = world().await;
    let t = &w.t;
    let g1 = game(t, &w.olga, "Space Dodge", true).await;
    let g2 = game(t, &w.olga, "Pixel Peaks", true).await;

    // Adds to a private collection write nothing.
    let private = mk(t, &w.cora, "Play later", "private").await;
    add(t, &w.cora, &private, &g1).await;
    assert_eq!(event_rows(t, &private).await, 0);
    assert_eq!(notif_rows(t, &private).await, 0);
    assert!(notifs(t, &w.olga).await.is_empty());

    // PATCH to private hides both; back to public shows them again.
    let cid = mk(t, &w.cora, "Cozy", "public").await;
    add(t, &w.cora, &cid, &g1).await;
    assert_eq!(coll_items(t, &w.finn).await.len(), 1);
    assert_eq!(notifs(t, &w.olga).await.len(), 1);
    assert_eq!(unread(t, &w.olga).await, 1);
    patch_collection(t, &w.cora, &cid, json!({ "visibility": "private" })).await;
    assert!(coll_items(t, &w.finn).await.is_empty());
    assert!(notifs(t, &w.olga).await.is_empty());
    assert_eq!(unread(t, &w.olga).await, 0);
    // A game added while private is never announced.
    add(t, &w.cora, &cid, &g2).await;
    assert_eq!(event_rows(t, &cid).await, 1);
    assert_eq!(notif_rows(t, &cid).await, 1);
    patch_collection(t, &w.cora, &cid, json!({ "visibility": "public" })).await;
    let items = coll_items(t, &w.finn).await;
    assert_eq!(items.len(), 1);
    assert_eq!(game_ids(&items[0]), vec![g1.clone()]);
    assert_eq!(items[0]["collection"]["gameCount"], 1);
    let n = notifs(t, &w.olga).await;
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["game"]["id"], g1.as_str());
    assert_eq!(unread(t, &w.olga).await, 1);

    // POST with gameId: private writes nothing, public writes both.
    for (vis, expected) in [("private", 0), ("public", 1)] {
        let r = t
            .json(
                Method::POST,
                "/api/collections",
                Some(&w.cora),
                json!({ "title": format!("New {vis}"), "visibility": vis, "gameId": g2 }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        let new_id = s(&r.json()["id"]);
        assert_eq!(event_rows(t, &new_id).await, expected, "{vis}");
        assert_eq!(notif_rows(t, &new_id).await, expected, "{vis}");
    }
}

// ---------------------------------------------------------------------------
// Read-time filters
// ---------------------------------------------------------------------------

#[tokio::test]
async fn read_time_filters_and_cascades() {
    let w = world().await;
    let t = &w.t;
    let g1 = game(t, &w.olga, "Space Dodge", true).await;
    let g2 = game(t, &w.olga, "Pixel Peaks", true).await;
    let cid = mk(t, &w.cora, "Cozy", "public").await;
    add(t, &w.cora, &cid, &g1).await;
    add(t, &w.cora, &cid, &g2).await;

    // Unpublishing a listed game drops it from the item.
    set_published(t, &w.olga, &g1, false).await;
    let items = coll_items(t, &w.finn).await;
    assert_eq!(items[0]["collection"]["gameCount"], 1);
    assert_eq!(game_ids(&items[0]), vec![g2.clone()]);
    set_published(t, &w.olga, &g1, true).await;
    assert_eq!(
        coll_items(t, &w.finn).await[0]["collection"]["gameCount"],
        2
    );

    // Removing every announced game drops the item.
    remove(t, &w.cora, &cid, &g1).await;
    remove(t, &w.cora, &cid, &g2).await;
    assert!(coll_items(t, &w.finn).await.is_empty());

    // The curator's own unpublished game writes nothing.
    let own = game(t, &w.cora, "Draft", false).await;
    let other = mk(t, &w.cora, "Mine", "public").await;
    add(t, &w.cora, &other, &own).await;
    assert_eq!(event_rows(t, &other).await, 0);

    // Deleting the collection cascades its feed rows and notifications.
    add(t, &w.cora, &cid, &g1).await;
    assert_eq!(event_rows(t, &cid).await, 1);
    // g1's withdrawn notification is restored; g2's stays stored but withdrawn.
    assert_eq!(notif_rows(t, &cid).await, 2);
    assert_eq!(notifs(t, &w.olga).await.len(), 1);
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/collections/{cid}"),
            Some(&w.cora),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert_eq!(event_rows(t, &cid).await, 0);
    assert_eq!(notif_rows(t, &cid).await, 0);
    assert!(coll_items(t, &w.finn).await.is_empty());
    assert!(notifs(t, &w.olga).await.is_empty());
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

#[tokio::test]
async fn added_to_collection_notification_lifecycle() {
    let w = world().await;
    let t = &w.t;
    let g = game(t, &w.olga, "Space Dodge", true).await;
    let c1 = mk(t, &w.cora, "Cozy games", "public").await;
    add(t, &w.cora, &c1, &g).await;

    let n = notifs(t, &w.olga).await;
    assert_eq!(n.len(), 1);
    let x = &n[0];
    assert_eq!(x["actors"][0]["id"], w.cora_id.as_str());
    assert_eq!(x["actorCount"], 1);
    assert_eq!(x["eventCount"], 1);
    assert_eq!(x["game"]["id"], g.as_str());
    assert_eq!(x["game"]["title"], "Space Dodge");
    assert_eq!(
        x["collection"],
        json!({ "id": c1, "title": "Cozy games", "path": format!("/c/{c1}") })
    );
    assert_eq!(x["path"], format!("/c/{c1}"));
    for k in ["commentId", "excerpt", "threadId"] {
        assert_eq!(x[k], Value::Null, "{k}");
    }
    assert_eq!(x["ownsThread"], false);
    assert_eq!(x["creatorHeart"], false);
    assert_eq!(x["read"], false);
    let updated_at = x["updatedAt"].clone();
    assert_eq!(unread(t, &w.olga).await, 1);

    // Other kinds carry `collection: null`.
    let all = t.get("/api/notifications", Some(&w.cora)).await.json();
    let follow_item = all["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "follow")
        .unwrap()
        .clone();
    assert_eq!(follow_item["collection"], Value::Null);

    // The curator's own game: no notification.
    let own = game(t, &w.cora, "Mine", true).await;
    add(t, &w.cora, &c1, &own).await;
    assert!(notifs(t, &w.cora).await.is_empty());

    // A second collection: a second notification.
    let c2 = mk(t, &w.cora, "Best of", "public").await;
    add(t, &w.cora, &c2, &g).await;
    assert_eq!(notifs(t, &w.olga).await.len(), 2);
    assert_eq!(unread(t, &w.olga).await, 2);

    // Removed while unread: withdrawn. Re-added: restored without moving.
    remove(t, &w.cora, &c1, &g).await;
    let n = notifs(t, &w.olga).await;
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["collection"]["id"], c2.as_str());
    assert_eq!(unread(t, &w.olga).await, 1);
    add(t, &w.cora, &c1, &g).await;
    let n = notifs(t, &w.olga).await;
    assert_eq!(n.len(), 2);
    let back = n
        .iter()
        .find(|x| x["collection"]["id"] == c1.as_str())
        .unwrap();
    assert_eq!(back["updatedAt"], updated_at);
    assert_eq!(back["eventCount"], 1);
    assert_eq!(unread(t, &w.olga).await, 2);
    assert_eq!(notif_rows(t, &c1).await, 1);

    // Renames show at once.
    patch_collection(t, &w.cora, &c1, json!({ "title": "Coziest" })).await;
    let n = notifs(t, &w.olga).await;
    let renamed = n
        .iter()
        .find(|x| x["collection"]["id"] == c1.as_str())
        .unwrap();
    assert_eq!(renamed["collection"]["title"], "Coziest");

    // Read, then remove and re-add: nothing new.
    mark_all_read(t, &w.olga).await;
    remove(t, &w.cora, &c2, &g).await;
    add(t, &w.cora, &c2, &g).await;
    let n = notifs(t, &w.olga).await;
    assert_eq!(n.len(), 2);
    assert!(n.iter().all(|x| x["read"] == true));
    assert_eq!(unread(t, &w.olga).await, 0);
    assert_eq!(notif_rows(t, &c2).await, 1);
}

#[tokio::test]
async fn setting_and_game_mute_suppress_the_notification() {
    let w = world().await;
    let t = &w.t;
    let g = game(t, &w.olga, "Space Dodge", true).await;

    // Settings: default true, round trip, 422 on a non-boolean.
    let r = t.get("/api/notifications/settings", Some(&w.olga)).await;
    assert_eq!(r.json()["collections"], true);
    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&w.olga),
            json!({ "collections": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["collections"], false);
    assert_eq!(r.json()["pins"], true);
    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&w.olga),
            json!({ "collections": "no" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");

    // Off: no notification (the feed event is still written).
    let c1 = mk(t, &w.cora, "One", "public").await;
    add(t, &w.cora, &c1, &g).await;
    assert_eq!(notif_rows(t, &c1).await, 0);
    assert_eq!(event_rows(t, &c1).await, 1);

    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&w.olga),
            json!({ "collections": true }),
        )
        .await;
    assert_eq!(r.json()["collections"], true);
    let c2 = mk(t, &w.cora, "Two", "public").await;
    add(t, &w.cora, &c2, &g).await;
    assert_eq!(unread(t, &w.olga).await, 1);

    // A game mute marks the unread one read and suppresses later ones.
    let r = t
        .send(
            Method::PUT,
            &format!("/api/notifications/mutes/games/{g}"),
            Some(&w.olga),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["unread"], 0);
    assert_eq!(notifs(t, &w.olga).await[0]["read"], true);
    let c3 = mk(t, &w.cora, "Three", "public").await;
    add(t, &w.cora, &c3, &g).await;
    assert_eq!(notif_rows(t, &c3).await, 0);
    assert_eq!(unread(t, &w.olga).await, 0);
}

// ---------------------------------------------------------------------------
// Writes that announce nothing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn note_reorder_and_details_write_nothing() {
    let w = world().await;
    let t = &w.t;
    let g1 = game(t, &w.olga, "Space Dodge", true).await;
    let g2 = game(t, &w.olga, "Pixel Peaks", true).await;
    let cid = mk(t, &w.cora, "Cozy", "public").await;
    add(t, &w.cora, &cid, &g1).await;
    add(t, &w.cora, &cid, &g2).await;
    let id_before = scalar(
        t,
        "SELECT id FROM activity_events WHERE collection_id = ?",
        &cid,
    )
    .await;
    let notifs_before = notif_rows(t, &cid).await;
    let unread_before = unread(t, &w.olga).await;

    let r = add_note(t, &w.cora, &cid, &g1, "A new note").await;
    assert_eq!(r["added"], false);
    let r = t
        .json(
            Method::PUT,
            &format!("/api/collections/{cid}/order"),
            Some(&w.cora),
            json!({ "gameIds": [g2, g1] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    patch_collection(
        t,
        &w.cora,
        &cid,
        json!({ "title": "Coziest", "description": "Updated" }),
    )
    .await;

    assert_eq!(event_rows(t, &cid).await, 1);
    let id_after = scalar(
        t,
        "SELECT id FROM activity_events WHERE collection_id = ?",
        &cid,
    )
    .await;
    assert_eq!(id_before, id_after);
    assert_eq!(notif_rows(t, &cid).await, notifs_before);
    assert_eq!(unread(t, &w.olga).await, unread_before);
    // The item shows the current note and title.
    let it = &coll_items(t, &w.finn).await[0];
    assert_eq!(it["collection"]["title"], "Coziest");
    let g1_entry = it["collection"]["games"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["game"]["id"] == g1.as_str())
        .unwrap()
        .clone();
    assert_eq!(g1_entry["note"], "A new note");
}

// ---------------------------------------------------------------------------
// Rate limit (ManualClock)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refused_add_writes_nothing() {
    let w = world_with(|c| c.rate_limit = true).await;
    let t = &w.t;
    let g1 = game(t, &w.olga, "Space Dodge", true).await;
    let g2 = game(t, &w.olga, "Pixel Peaks", true).await;
    let cid = mk(t, &w.cora, "Cozy", "public").await; // write 1
    add(t, &w.cora, &cid, &g1).await; // write 2
    for i in 0..118 {
        add_note(t, &w.cora, &cid, &g1, &format!("note {i}")).await;
    }
    let r = put_item(t, &w.cora, &cid, &g2, None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.text());
    assert_eq!(r.error_code(), "rate_limited");
    let ids: String =
        sqlx::query_scalar("SELECT game_ids FROM activity_events WHERE collection_id = ?")
            .bind(&cid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(ids, json!([g1]).to_string());
    assert_eq!(notifs(t, &w.olga).await.len(), 1);

    // 120 per 10 min refills one token every 5 s.
    t.clock.advance(Duration::from_secs(5));
    let r = add(t, &w.cora, &cid, &g2).await;
    assert_eq!(r["added"], true);
    let ids: String =
        sqlx::query_scalar("SELECT game_ids FROM activity_events WHERE collection_id = ?")
            .bind(&cid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(ids, json!([g2, g1]).to_string());
    assert_eq!(notifs(t, &w.olga).await.len(), 2);
}
