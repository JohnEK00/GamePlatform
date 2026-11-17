//! F015: screenshots in the feed (`screenshotPosted`) and on profiles
//! (`GET /api/users/{username}/screenshots`).

mod common;

use std::io::Cursor;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Helpers (copied from tests/f005.rs and tests/f021.rs)
// ---------------------------------------------------------------------------

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

async fn post(t: &TestApp, tok: &str, gid: &str, img: &[u8], caption: Option<&str>) -> Resp {
    let mut parts = vec![Part::File("image", "shot.png", "image/png", img)];
    if let Some(c) = caption {
        parts.push(Part::Text("caption", c));
    }
    t.multipart(
        Method::POST,
        &format!("/api/games/{gid}/screenshots"),
        Some(tok),
        &parts,
    )
    .await
}

async fn post_ok(t: &TestApp, tok: &str, gid: &str, caption: Option<&str>) -> Value {
    let r = post(t, tok, gid, &png(64, 64), caption).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn delete(t: &TestApp, tok: &str, id: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/screenshots/{id}"),
        Some(tok),
        None,
        vec![],
        &[],
    )
    .await
}

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn sid(v: &Value) -> String {
    s(&v["id"])
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

/// The viewer's `screenshotPosted` items (all kinds requested).
async fn shot_items(t: &TestApp, tok: &str) -> Vec<Value> {
    feed(t, tok, "?limit=50")
        .await
        .into_iter()
        .filter(|i| i["kind"] == "screenshotPosted")
        .collect()
}

async fn make_admin(t: &TestApp, username: &str) {
    sqlx::query("UPDATE users SET role = 'admin' WHERE username_lower = ?")
        .bind(username.to_lowercase())
        .execute(&t.state.db)
        .await
        .unwrap();
}

/// Ids of the stored `screenshotPosted` rows, oldest first.
async fn event_ids(t: &TestApp) -> Vec<i64> {
    sqlx::query_scalar("SELECT id FROM activity_events WHERE kind = 'screenshotPosted' ORDER BY id")
        .fetch_all(&t.state.db)
        .await
        .unwrap()
}

fn ids_of(item: &Value) -> Vec<String> {
    item["screenshots"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(sid)
        .collect()
}

/// `items` follow the F005 gallery order: `createdAt` desc, then `id` asc.
fn assert_gallery_order(items: &[Value]) {
    for w in items.windows(2) {
        let a = (s(&w[0]["createdAt"]), sid(&w[0]));
        let b = (s(&w[1]["createdAt"]), sid(&w[1]));
        assert!(a.0 > b.0 || (a.0 == b.0 && a.1 < b.1), "{a:?} then {b:?}");
    }
}

async fn set_created(t: &TestApp, id: &str, at: &str) {
    sqlx::query("UPDATE screenshots SET created_at = ? WHERE id = ?")
        .bind(at)
        .bind(id)
        .execute(&t.state.db)
        .await
        .unwrap();
}

async fn user_shots(t: &TestApp, tok: Option<&str>, username: &str, query: &str) -> Resp {
    t.get(&format!("/api/users/{username}/screenshots{query}"), tok)
        .await
}

fn list_ids(v: &Value) -> Vec<String> {
    v["items"].as_array().unwrap().iter().map(sid).collect()
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_adds_profile_index_and_leaves_activity_events_untouched() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    // The real server's database has the index after migrate.
    let t = setup().await;
    let idx: Option<String> = sqlx::query_scalar(
        "SELECT tbl_name FROM sqlite_master \
         WHERE type = 'index' AND name = 'idx_screenshots_author_created'",
    )
    .fetch_optional(&t.state.db)
    .await
    .unwrap();
    assert_eq!(idx.as_deref(), Some("screenshots"));

    // Replay the migrations: `activity_events` (table and indices) is the same after 0022 as
    // after 0019.
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();
    let schema_sql = "SELECT type, name, sql FROM sqlite_master \
                      WHERE tbl_name = 'activity_events' AND sql IS NOT NULL ORDER BY type, name";
    let early = [
        include_str!("../migrations/0001_init.sql"),
        include_str!("../migrations/0002_v2.sql"),
        include_str!("../migrations/0003_f001.sql"),
        include_str!("../migrations/0004_perf_indices.sql"),
        include_str!("../migrations/0005_f002.sql"),
        include_str!("../migrations/0006_f003.sql"),
        include_str!("../migrations/0007_f004.sql"),
        include_str!("../migrations/0008_review2.sql"),
        include_str!("../migrations/0009_f005.sql"),
        include_str!("../migrations/0010_f009.sql"),
        include_str!("../migrations/0011_review3.sql"),
        include_str!("../migrations/0012_f006.sql"),
        include_str!("../migrations/0013_f007.sql"),
        include_str!("../migrations/0014_review4.sql"),
        include_str!("../migrations/0015_f017.sql"),
        include_str!("../migrations/0016_f008.sql"),
        include_str!("../migrations/0017_f018.sql"),
        include_str!("../migrations/0018_review6.sql"),
        include_str!("../migrations/0019_f021.sql"),
    ];
    for sql in early {
        sqlx::raw_sql(sql).execute(&db).await.unwrap();
    }
    let after_0019: Vec<(String, String, String)> =
        sqlx::query_as(schema_sql).fetch_all(&db).await.unwrap();
    assert!(!after_0019.is_empty());
    for sql in [
        include_str!("../migrations/0020_f016.sql"),
        include_str!("../migrations/0021_f020.sql"),
        include_str!("../migrations/0022_f015.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&db).await.unwrap();
    }
    let after_0022: Vec<(String, String, String)> =
        sqlx::query_as(schema_sql).fetch_all(&db).await.unwrap();
    assert_eq!(after_0019, after_0022);
    let idx_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_screenshots_author_created'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(
        idx_sql.contains("screenshots(author_id, created_at DESC, id)"),
        "{idx_sql}"
    );
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn feed_item_coalesces_per_day_and_follows_only() {
    same_utc_day(feed_item_coalesces_per_day_and_follows_only_body).await;
}

/// Six real posts that must land on one UTC day (L5: run through `same_utc_day`).
async fn feed_item_coalesces_per_day_and_follows_only_body() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, ana_id) = t.register("ana").await;
    let (fan, _) = t.register("fan").await;
    let (stranger, _) = t.register("stranger").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    follow(&t, &fan, "ana").await;

    // One post → one item.
    let first = post_ok(&t, &ana, &gid, Some("Nice view")).await;
    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 1, "{items:?}");
    let item = &items[0];
    assert_eq!(item["game"]["id"], gid.as_str());
    assert_eq!(item["game"]["title"], "Kiln Clash");
    assert_eq!(item["actor"]["id"], ana_id.as_str());
    assert_eq!(item["actor"]["username"], "ana");
    assert_eq!(item["reason"], "following");
    assert!(item["version"].is_null());
    assert!(item["score"].is_null());
    assert!(item["achievement"].is_null());
    assert!(item["update"].is_null());
    assert!(item["collection"].is_null());
    assert_eq!(item["screenshots"]["count"], 1);
    assert_eq!(ids_of(item), vec![sid(&first)]);
    let shot = &item["screenshots"]["items"][0];
    assert_eq!(shot["caption"], "Nice view");
    assert_eq!(shot["gameId"], gid.as_str());
    assert_eq!(shot["author"]["username"], "ana");
    assert_eq!(shot["thumbUrl"], first["thumbUrl"]);
    assert_eq!(shot["canDelete"], false);
    assert_eq!(item["createdAt"], shot["createdAt"]);
    assert_eq!(item["createdAt"], first["createdAt"]);
    let first_item_id: i64 = s(&item["id"]).parse().unwrap();

    // Two more the same day → still one item, with a higher id, count 3, newest first.
    let mut posted = vec![sid(&first)];
    for _ in 0..2 {
        posted.push(sid(&post_ok(&t, &ana, &gid, None).await));
    }
    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 1);
    let item = &items[0];
    let id: i64 = s(&item["id"]).parse().unwrap();
    assert!(id > first_item_id);
    assert_eq!(item["screenshots"]["count"], 3);
    let got = item["screenshots"]["items"].as_array().unwrap();
    assert_eq!(got.len(), 3);
    assert_gallery_order(got);
    let mut got_ids = ids_of(item);
    got_ids.sort();
    posted.sort();
    assert_eq!(got_ids, posted);
    assert_eq!(item["createdAt"], got[0]["createdAt"]);
    assert_eq!(event_ids(&t).await.len(), 1);

    // Six posts → count 6, four items.
    for _ in 0..3 {
        post_ok(&t, &ana, &gid, None).await;
    }
    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["screenshots"]["count"], 6);
    let got = items[0]["screenshots"]["items"].as_array().unwrap();
    assert_eq!(got.len(), 4);
    assert_gallery_order(got);

    // `kinds` filters.
    let only = feed(&t, &fan, "?kinds=screenshotPosted").await;
    assert_eq!(only.len(), 1);
    assert_eq!(only[0]["kind"], "screenshotPosted");
    let none = feed(&t, &fan, "?kinds=gamePublished").await;
    assert!(none.iter().all(|i| i["kind"] != "screenshotPosted"));

    // A non-follower and the author themself don't see it.
    assert!(shot_items(&t, &stranger).await.is_empty());
    assert!(shot_items(&t, &ana).await.is_empty());
}

#[tokio::test]
async fn owner_shots_are_announced_and_other_kinds_have_null_screenshots() {
    let t = setup().await;
    let (owner, owner_id) = t.register("olga").await;
    let (fan, _) = t.register("fan").await;
    follow(&t, &fan, "olga").await;
    let gid = game(&t, &owner, "Space Dodge", true).await;
    let shot = post_ok(&t, &owner, &gid, None).await;
    let items = feed(&t, &fan, "").await;
    let shots: Vec<&Value> = items
        .iter()
        .filter(|i| i["kind"] == "screenshotPosted")
        .collect();
    assert_eq!(shots.len(), 1);
    assert_eq!(shots[0]["actor"]["id"], owner_id.as_str());
    assert_eq!(ids_of(shots[0]), vec![sid(&shot)]);
    let published = items
        .iter()
        .find(|i| i["kind"] == "gamePublished")
        .expect("gamePublished item");
    assert!(published.get("screenshots").is_some());
    assert!(published["screenshots"].is_null());
}

#[tokio::test]
async fn unpublished_game_writes_nothing_and_hides_the_item() {
    same_utc_day(unpublished_game_writes_nothing_and_hides_the_item_body).await;
}

async fn unpublished_game_writes_nothing_and_hides_the_item_body() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (fan, _) = t.register("fan").await;
    follow(&t, &fan, "olga").await;
    let gid = game(&t, &owner, "Secret", false).await;

    let early = post_ok(&t, &owner, &gid, None).await;
    assert!(event_ids(&t).await.is_empty());
    assert!(shot_items(&t, &fan).await.is_empty());

    // Publish, post again the same day: the earlier shot is included (documented).
    set_published(&t, &owner, &gid, true).await;
    let late = post_ok(&t, &owner, &gid, None).await;
    assert_eq!(event_ids(&t).await.len(), 1);
    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["screenshots"]["count"], 2);
    let mut got = ids_of(&items[0]);
    got.sort();
    let mut want = vec![sid(&early), sid(&late)];
    want.sort();
    assert_eq!(got, want);

    // Unpublish hides it; republish shows it again.
    set_published(&t, &owner, &gid, false).await;
    assert!(shot_items(&t, &fan).await.is_empty());
    assert!(feed(&t, &fan, "?kinds=screenshotPosted").await.is_empty());
    set_published(&t, &owner, &gid, true).await;
    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["screenshots"]["count"], 2);
}

#[tokio::test]
async fn items_are_split_by_utc_day() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, ana_id) = t.register("ana").await;
    let (fan, _) = t.register("fan").await;
    follow(&t, &fan, "ana").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(sid(&post_ok(&t, &ana, &gid, None).await));
    }
    // Fixed days, so the test never depends on the clock (or on running across midnight):
    // the rows the posts wrote are replaced by one row per day.
    let yesterday = "2026-11-09";
    let y_at = format!("{yesterday}T23:59:59.900Z");
    let today = "2026-11-10";
    set_created(&t, &ids[0], &y_at).await;
    set_created(&t, &ids[1], &format!("{today}T00:00:00.100Z")).await;
    set_created(&t, &ids[2], &format!("{today}T08:00:00.000Z")).await;
    sqlx::query("DELETE FROM activity_events WHERE kind = 'screenshotPosted'")
        .execute(&t.state.db)
        .await
        .unwrap();
    for (day, at) in [
        (yesterday.to_string(), y_at.clone()),
        (today.to_string(), format!("{today}T08:00:00.000Z")),
    ] {
        sqlx::query(
            "INSERT INTO activity_events (actor_id, kind, game_id, day, created_at) \
             VALUES (?, 'screenshotPosted', ?, ?, ?)",
        )
        .bind(&ana_id)
        .bind(&gid)
        .bind(day)
        .bind(at)
        .execute(&t.state.db)
        .await
        .unwrap();
    }

    let items = shot_items(&t, &fan).await;
    assert_eq!(items.len(), 2, "{items:?}");
    let y_item = items
        .iter()
        .find(|i| i["createdAt"] == y_at.as_str())
        .unwrap();
    assert_eq!(y_item["screenshots"]["count"], 1);
    assert_eq!(ids_of(y_item), vec![ids[0].clone()]);
    let t_item = items
        .iter()
        .find(|i| i["createdAt"] != y_at.as_str())
        .unwrap();
    assert_eq!(t_item["screenshots"]["count"], 2);
    let mut got = ids_of(t_item);
    got.sort();
    let mut want = vec![ids[1].clone(), ids[2].clone()];
    want.sort();
    assert_eq!(got, want);
}

#[tokio::test]
async fn deleted_screenshots_disappear_at_read_time() {
    same_utc_day(deleted_screenshots_disappear_at_read_time_body).await;
}

async fn deleted_screenshots_disappear_at_read_time_body() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, _) = t.register("ana").await;
    let (fan, _) = t.register("fan").await;
    let (boss, _) = t.register("boss").await;
    make_admin(&t, "boss").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    // An older item from the same followed actor.
    let older = game(&t, &ana, "Ana's Game", true).await;
    follow(&t, &fan, "ana").await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(sid(&post_ok(&t, &ana, &gid, None).await));
    }

    let r = delete(&t, &ana, &ids[0]).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    let items = shot_items(&t, &fan).await;
    assert_eq!(items[0]["screenshots"]["count"], 2);
    assert!(!ids_of(&items[0]).contains(&ids[0]));

    // The game owner deletes one, the author the last → the item is gone.
    assert_eq!(
        delete(&t, &owner, &ids[1]).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(shot_items(&t, &fan).await[0]["screenshots"]["count"], 1);
    assert_eq!(
        delete(&t, &ana, &ids[2]).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(shot_items(&t, &fan).await.is_empty());
    assert_eq!(event_ids(&t).await.len(), 1, "the row stays; it is hidden");

    // Paging with limit=1 still reaches the older item.
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let q = match &cursor {
            Some(c) => format!("?limit=1&cursor={c}"),
            None => "?limit=1".to_string(),
        };
        let page = feed_page(&t, &fan, &q).await;
        seen.extend(page["items"].as_array().unwrap().iter().cloned());
        match page["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert!(seen.iter().all(|i| i["kind"] != "screenshotPosted"));
    assert!(
        seen.iter()
            .any(|i| i["kind"] == "gamePublished" && i["game"]["id"] == older.as_str()),
        "{seen:?}"
    );

    // An admin resolving a screenshot report with `delete` has the same effect.
    let shot = sid(&post_ok(&t, &ana, &gid, None).await);
    assert_eq!(shot_items(&t, &fan).await.len(), 1);
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(&fan),
            json!({ "targetType": "screenshot", "targetId": shot, "reason": "offensive" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rep = sid(&r.json());
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rep}/resolve"),
            Some(&boss),
            json!({ "action": "delete" }),
        )
        .await;
    assert!(r.status.is_success(), "{}", r.text());
    assert!(shot_items(&t, &fan).await.is_empty());
}

#[tokio::test]
async fn feed_can_delete_per_viewer() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, _) = t.register("ana").await;
    let (plain, _) = t.register("plain").await;
    let (boss, _) = t.register("boss").await;
    make_admin(&t, "boss").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    for tok in [&owner, &plain, &boss] {
        follow(&t, tok, "ana").await;
    }
    post_ok(&t, &ana, &gid, None).await;
    for (tok, want) in [(&plain, false), (&owner, true), (&boss, true)] {
        let items = shot_items(&t, tok).await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["screenshots"]["items"][0]["canDelete"], want);
    }
}

#[tokio::test]
async fn writer_failure_is_best_effort() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    sqlx::query(
        "CREATE TRIGGER f015_fail BEFORE INSERT ON activity_events \
         WHEN NEW.kind = 'screenshotPosted' BEGIN SELECT RAISE(ABORT, 'f015 test'); END",
    )
    .execute(&t.state.db)
    .await
    .unwrap();
    let shot = post_ok(&t, &owner, &gid, None).await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM screenshots WHERE id = ?")
        .bind(sid(&shot))
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(event_ids(&t).await.is_empty());
}

#[tokio::test]
async fn rejected_posts_write_nothing() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;

    // 422 caption.
    let long = "x".repeat(141);
    let r = post(&t, &owner, &gid, &png(64, 64), Some(&long)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    // 413.
    let mut big = png_bytes();
    big.resize(2 * 1024 * 1024 + 1, 0);
    let r = post(&t, &owner, &gid, &big, None).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.text());
    assert!(event_ids(&t).await.is_empty());

    // 422 cap: the day's row is not replaced.
    for _ in 0..20 {
        post_ok(&t, &owner, &gid, None).await;
    }
    let before = event_ids(&t).await;
    assert_eq!(before.len(), 1);
    let r = post(&t, &owner, &gid, &png(64, 64), None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        r.json()["error"]["message"],
        "You can post at most 20 screenshots per game"
    );
    assert_eq!(event_ids(&t).await, before);
}

#[tokio::test]
async fn rate_limited_posts_write_nothing() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("olga").await;
    let gid = game(&t, &owner, "Kiln Clash", true).await;
    for _ in 0..10 {
        post_ok(&t, &owner, &gid, None).await;
    }
    let before = event_ids(&t).await;
    assert_eq!(before.len(), 1);
    let r = post(&t, &owner, &gid, &png(64, 64), None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(event_ids(&t).await, before);
}

// ---------------------------------------------------------------------------
// GET /api/users/{username}/screenshots
// ---------------------------------------------------------------------------

#[tokio::test]
async fn profile_list_visibility_order_and_shape() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, _) = t.register("Ana").await;
    let (other, _) = t.register("other").await;
    let g = game(&t, &owner, "Kiln Clash", true).await;
    let later_hidden = game(&t, &owner, "Withdrawn", true).await;
    let own_private = game(&t, &ana, "Ana WIP", false).await;

    let s1 = sid(&post_ok(&t, &ana, &g, Some("first")).await);
    let s2 = sid(&post_ok(&t, &ana, &g, None).await);
    let s3 = sid(&post_ok(&t, &ana, &later_hidden, None).await);
    let s4 = sid(&post_ok(&t, &ana, &own_private, None).await);
    set_created(&t, &s1, "2026-11-01T10:00:00.000Z").await;
    set_created(&t, &s2, "2026-11-02T10:00:00.000Z").await;
    set_created(&t, &s3, "2026-11-03T10:00:00.000Z").await;
    set_created(&t, &s4, "2026-11-04T10:00:00.000Z").await;
    set_published(&t, &owner, &later_hidden, false).await;

    // Anonymous: published games only, newest first, with the game ref.
    let r = user_shots(&t, None, "ana", "").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["total"], 2);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 12);
    assert_eq!(list_ids(&v), vec![s2.clone(), s1.clone()]);
    let item = &v["items"][1];
    assert_eq!(item["game"], json!({ "id": g, "title": "Kiln Clash" }));
    assert_eq!(item["gameId"], g.as_str());
    assert_eq!(item["caption"], "first");
    assert_eq!(item["author"]["username"], "Ana");
    assert_eq!(item["canDelete"], false);
    assert!(item["thumbUrl"].as_str().unwrap().contains(&s1));
    assert!(item["imageUrl"].is_string());
    assert!(item["width"].is_i64());
    assert!(item["createdAt"].is_string());

    // Another user: same set.
    let v = user_shots(&t, Some(&other), "ana", "").await.json();
    assert_eq!(list_ids(&v), vec![s2.clone(), s1.clone()]);
    // The author: plus their own unpublished game, not the other owner's unpublished one.
    let v = user_shots(&t, Some(&ana), "ana", "").await.json();
    assert_eq!(v["total"], 3);
    assert_eq!(list_ids(&v), vec![s4.clone(), s2.clone(), s1.clone()]);
    // The owner of the unpublished game sees that shot.
    let v = user_shots(&t, Some(&owner), "ana", "").await.json();
    assert_eq!(v["total"], 3);
    assert_eq!(list_ids(&v), vec![s3.clone(), s2.clone(), s1.clone()]);

    // Case-insensitive username.
    let v = user_shots(&t, None, "aNA", "").await.json();
    assert_eq!(v["total"], 2);
}

#[tokio::test]
async fn profile_list_paging_and_errors() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, _) = t.register("ana").await;
    let g = game(&t, &owner, "Kiln Clash", true).await;
    let mut ids = Vec::new();
    for i in 0..3 {
        let id = sid(&post_ok(&t, &ana, &g, None).await);
        set_created(&t, &id, &format!("2026-11-0{}T10:00:00.000Z", i + 1)).await;
        ids.push(id);
    }

    let v = user_shots(&t, None, "ana", "?perPage=1&page=2")
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["page"], 2);
    assert_eq!(v["perPage"], 1);
    assert_eq!(list_ids(&v), vec![ids[1].clone()]);
    let v = user_shots(&t, None, "ana", "?perPage=500").await.json();
    assert_eq!(v["perPage"], 50);
    assert_eq!(v["items"].as_array().unwrap().len(), 3);
    let v = user_shots(&t, None, "ana", "?page=0&perPage=2")
        .await
        .json();
    assert_eq!(v["page"], 1);
    assert_eq!(list_ids(&v), vec![ids[2].clone(), ids[1].clone()]);
    let v = user_shots(&t, None, "ana", "?page=9").await.json();
    assert_eq!(v["total"], 3);
    assert!(v["items"].as_array().unwrap().is_empty());

    let r = user_shots(&t, None, "ana", "?page=x").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.error_code(), "bad_request");
    assert_eq!(r.json()["error"]["message"], "page must be an integer");
    let r = user_shots(&t, None, "ana", "?perPage=x").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"]["message"], "perPage must be an integer");
    let r = user_shots(&t, None, "nobody", "").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
    assert_eq!(r.json()["error"]["message"], "User not found");

    // A user without screenshots: an empty page.
    let v = user_shots(&t, None, "olga", "").await.json();
    assert_eq!(v["total"], 0);
    assert!(v["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn profile_list_can_delete() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (ana, _) = t.register("ana").await;
    let (other, _) = t.register("other").await;
    let (boss, _) = t.register("boss").await;
    make_admin(&t, "boss").await;
    let g = game(&t, &owner, "Kiln Clash", true).await;
    post_ok(&t, &ana, &g, None).await;
    for (tok, want) in [
        (Some(&ana), true),
        (Some(&owner), true),
        (Some(&boss), true),
        (Some(&other), false),
        (None, false),
    ] {
        let v = user_shots(&t, tok.map(|s| s.as_str()), "ana", "")
            .await
            .json();
        assert_eq!(v["items"][0]["canDelete"], want);
    }
}
