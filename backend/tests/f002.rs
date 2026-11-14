//! F002 Follow creators and an activity feed (docs/features/F002-follow-and-feed.md,
//! API.md § F002).

mod common;

use std::collections::HashSet;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn follow(t: &TestApp, tok: Option<&str>, username: &str) -> Resp {
    t.send(
        Method::PUT,
        &format!("/api/users/{username}/follow"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn unfollow(t: &TestApp, tok: Option<&str>, username: &str) -> Resp {
    t.send(
        Method::DELETE,
        &format!("/api/users/{username}/follow"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

async fn follow_ok(t: &TestApp, tok: &str, username: &str) {
    let r = follow(t, Some(tok), username).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn feed(t: &TestApp, tok: &str, query: &str) -> Value {
    let r = t.get(&format!("/api/feed{query}"), Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

fn kinds_of(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap().to_string())
        .collect()
}

async fn event_count(t: &TestApp, game_id: &str, kind: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM activity_events WHERE game_id = ? AND kind = ?")
        .bind(game_id)
        .bind(kind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

fn bundle_with(manifest: &Value) -> Vec<u8> {
    let m = serde_json::to_vec(manifest).unwrap();
    make_zip(&[
        ("game.json", m.as_slice()),
        ("main.js", b"export default {};"),
        ("assets/ach.png", b"\x89PNG\r\n\x1a\nfake"),
    ])
}

fn manifest(achievements: Value) -> Value {
    json!({ "name": "Feed Game", "entry": "main.js", "width": 320, "height": 240,
            "achievements": achievements })
}

async fn create_with(t: &TestApp, tok: &str, zip: &[u8], published: bool) -> String {
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(tok),
            &[
                Part::Text("title", "Feed Game"),
                Part::Text("published", if published { "true" } else { "false" }),
                Part::File("bundle", "g.zip", "application/zip", zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

async fn game(t: &TestApp, tok: &str, published: bool) -> String {
    t.create_game(tok, "Game", "", published).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn replace(t: &TestApp, tok: &str, id: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(tok),
        &[Part::File("bundle", "g.zip", "application/zip", zip)],
    )
    .await
}

async fn set_published(t: &TestApp, tok: &str, id: &str, published: bool) {
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{id}"),
            Some(tok),
            json!({ "published": published }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn submit(t: &TestApp, tok: &str, gid: &str, score: i64) -> Value {
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/scores"),
            Some(tok),
            json!({ "score": score }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn unlock(t: &TestApp, tok: &str, gid: &str, ach: &str) -> Value {
    let r = t
        .send(
            Method::POST,
            &format!("/api/games/{gid}/achievements/{ach}"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn favorite(t: &TestApp, tok: &str, gid: &str) {
    let r = t
        .send(
            Method::PUT,
            &format!("/api/games/{gid}/favorite"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn follow_unfollow_idempotent_and_errors() {
    let t = setup().await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;

    assert_eq!(
        follow(&t, None, "bob").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        unfollow(&t, None, "bob").await.status,
        StatusCode::UNAUTHORIZED
    );

    for _ in 0..2 {
        let r = follow(&t, Some(&a), "BoB").await; // case-insensitive
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(r.json(), json!({ "following": true, "followers": 1 }));
    }
    let r = follow(&t, Some(&a), "alice").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    let r = unfollow(&t, Some(&a), "ALICE").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = follow(&t, Some(&a), "nobody").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
    assert_eq!(
        unfollow(&t, Some(&a), "nobody").await.status,
        StatusCode::NOT_FOUND
    );

    // b follows a too; counts are per target.
    let r = follow(&t, Some(&b), "alice").await;
    assert_eq!(r.json(), json!({ "following": true, "followers": 1 }));

    for _ in 0..2 {
        let r = unfollow(&t, Some(&a), "bob").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(r.json(), json!({ "following": false, "followers": 0 }));
    }
}

#[tokio::test]
async fn follow_cap() {
    let t = setup().await;
    let (a, a_id) = t.register("alice").await;
    t.register("target").await;
    t.register("already").await;
    follow_ok(&t, &a, "already").await;
    // 1999 more rows directly → 2000 follows in total.
    let mut tx = t.state.db.begin().await.unwrap();
    for i in 0..1999 {
        let id = format!("bulk-{i}");
        sqlx::query(
            "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
             display_name, created_at) VALUES (?1, ?1, ?1, ?1, ?1, 'x', ?1, '2026-01-01')",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, '2026-01-01')",
        )
        .bind(&a_id)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let r = follow(&t, Some(&a), "target").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
    assert_eq!(r.error_code(), "validation");
    // Re-following an existing row is still fine (no new row).
    assert_eq!(follow(&t, Some(&a), "already").await.status, StatusCode::OK);
    // After unfollowing one, the new follow works.
    assert_eq!(
        unfollow(&t, Some(&a), "already").await.status,
        StatusCode::OK
    );
    assert_eq!(follow(&t, Some(&a), "target").await.status, StatusCode::OK);
}

#[tokio::test]
async fn follower_lists_order_paging_cascade() {
    let t = setup().await;
    let (_, d_id) = t.register("dana").await;
    let mut toks = Vec::new();
    for name in ["user1", "user2", "user3"] {
        let (tok, _) = t.register(name).await;
        follow_ok(&t, &tok, "dana").await;
        toks.push(tok);
    }
    follow_ok(&t, &toks[0], "user2").await;

    let names = |v: &Value| -> Vec<String> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["username"].as_str().unwrap().to_string())
            .collect()
    };
    let r = t.get("/api/users/DANA/followers", None).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(names(&v), ["user3", "user2", "user1"]);
    assert_eq!(v["total"], 3);
    assert_eq!(v["perPage"], 24);
    assert!(v["items"][0]["displayName"].is_string());
    let v = t
        .get("/api/users/dana/followers?page=2&perPage=2", None)
        .await
        .json();
    assert_eq!(names(&v), ["user1"]);
    assert_eq!(
        (v["page"].as_i64(), v["total"].as_i64()),
        (Some(2), Some(3))
    );
    assert_eq!(
        t.get("/api/users/dana/followers?perPage=500", None)
            .await
            .json()["perPage"],
        100
    );
    let v = t.get("/api/users/user1/following", None).await.json();
    assert_eq!(names(&v), ["user2", "dana"]);
    assert_eq!(
        t.get("/api/users/dana/following", None).await.json()["total"],
        0
    );
    assert_eq!(
        t.get("/api/users/ghost/followers", None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get("/api/users/ghost/following", None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get("/api/users/dana/followers?page=x", None).await.status,
        StatusCode::BAD_REQUEST
    );

    // Deleting a user removes their follow rows on both sides.
    sqlx::query("DELETE FROM users WHERE username_lower = 'user2'")
        .execute(&t.state.db)
        .await
        .unwrap();
    let v = t.get("/api/users/dana/followers", None).await.json();
    assert_eq!(names(&v), ["user3", "user1"]);
    assert_eq!(
        names(&t.get("/api/users/user1/following", None).await.json()),
        ["dana"]
    );
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&d_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM follows")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn profile_follow_fields() {
    let t = setup().await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    let (c, _) = t.register("carol").await;
    follow_ok(&t, &b, "alice").await;
    follow_ok(&t, &c, "alice").await;
    follow_ok(&t, &a, "bob").await;

    let fields = |v: &Value| {
        (
            v["followers"].as_i64().unwrap(),
            v["following"].as_i64().unwrap(),
            v["isFollowing"].as_bool().unwrap(),
        )
    };
    let anon = t.get("/api/users/alice", None).await.json();
    assert_eq!(fields(&anon), (2, 1, false));
    assert!(anon["games"].is_array() && anon["gamesTotal"].is_number());
    assert_eq!(
        fields(&t.get("/api/users/alice", Some(&a)).await.json()),
        (2, 1, false)
    );
    assert_eq!(
        fields(&t.get("/api/users/alice", Some(&b)).await.json()),
        (2, 1, true)
    );
    assert_eq!(
        fields(&t.get("/api/users/bob", Some(&c)).await.json()),
        (1, 1, false)
    );
}

// ---------------------------------------------------------------------------
// Event production
// ---------------------------------------------------------------------------

#[tokio::test]
async fn game_published_events() {
    let t = setup().await;
    let (a, _) = t.register("alice").await;

    let g1 = game(&t, &a, true).await;
    assert_eq!(event_count(&t, &g1, "gamePublished").await, 1);

    let g2 = game(&t, &a, false).await;
    assert_eq!(event_count(&t, &g2, "gamePublished").await, 0);
    // A PATCH that doesn't publish emits nothing.
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{g2}"),
            Some(&a),
            json!({ "title": "Renamed" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(event_count(&t, &g2, "gamePublished").await, 0);
    set_published(&t, &a, &g2, true).await;
    assert_eq!(event_count(&t, &g2, "gamePublished").await, 1);
    // Publishing again while published, and unpublish + re-publish: still one.
    set_published(&t, &a, &g2, true).await;
    set_published(&t, &a, &g2, false).await;
    set_published(&t, &a, &g2, true).await;
    set_published(&t, &a, &g1, false).await;
    set_published(&t, &a, &g1, true).await;
    assert_eq!(event_count(&t, &g2, "gamePublished").await, 1);
    assert_eq!(event_count(&t, &g1, "gamePublished").await, 1);
    let version: Option<i64> =
        sqlx::query_scalar("SELECT version FROM activity_events WHERE game_id = ?")
            .bind(&g2)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(version, Some(1));
}

#[tokio::test]
async fn game_updated_coalesces_and_needs_published() {
    let t = setup().await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    follow_ok(&t, &b, "alice").await;
    let zip = valid_bundle();

    let g = game(&t, &a, true).await;
    assert_eq!(replace(&t, &a, &g, &zip).await.status, StatusCode::OK);
    assert_eq!(replace(&t, &a, &g, &zip).await.status, StatusCode::OK);
    assert_eq!(event_count(&t, &g, "gameUpdated").await, 1);
    let page = feed(&t, &b, "").await;
    assert_eq!(kinds_of(&page), ["gameUpdated", "gamePublished"]);
    assert_eq!(page["items"][0]["version"], 3);
    assert_eq!(page["items"][1]["version"], 1);

    // An update older than 24h is not replaced.
    sqlx::query(
        "UPDATE activity_events SET created_at = '2020-01-01T00:00:00.000Z', day = '2020-01-01' \
         WHERE game_id = ? AND kind = 'gameUpdated'",
    )
    .bind(&g)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert_eq!(replace(&t, &a, &g, &zip).await.status, StatusCode::OK);
    assert_eq!(event_count(&t, &g, "gameUpdated").await, 2);

    let hidden = game(&t, &a, false).await;
    assert_eq!(replace(&t, &a, &hidden, &zip).await.status, StatusCode::OK);
    assert_eq!(event_count(&t, &hidden, "gameUpdated").await, 0);
}

#[tokio::test]
async fn personal_best_events() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (sam, sam_id) = t.register("sam").await;
    let (f, _) = t.register("fan").await;
    follow_ok(&t, &f, "sam").await;
    follow_ok(&t, &f, "owner").await;
    let lb = json!({ "name": "PB", "entry": "main.js", "width": 320, "height": 240,
                     "leaderboard": { "order": "asc", "format": "time", "label": "Best time" } });
    let g = create_with(&t, &owner, &bundle_with(&lb), true).await;

    // The owner's own scores never produce events.
    assert_eq!(submit(&t, &owner, &g, 500).await["personalBest"], true);
    assert_eq!(event_count(&t, &g, "personalBest").await, 0);

    assert_eq!(submit(&t, &sam, &g, 9000).await["personalBest"], true);
    let page = feed(&t, &f, "?kinds=personalBest").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let item = &page["items"][0];
    assert_eq!(item["actor"]["username"], "sam");
    assert_eq!(item["reason"], "following");
    assert_eq!(item["version"], Value::Null);
    assert_eq!(item["achievement"], Value::Null);
    assert_eq!(
        item["score"],
        json!({ "value": 9000, "first": true,
                "leaderboard": { "order": "asc", "format": "time", "label": "Best time" } })
    );
    let first_id = item["id"].as_str().unwrap().to_string();

    // Not a PB (asc: higher is worse) → nothing changes.
    assert_eq!(submit(&t, &sam, &g, 9500).await["personalBest"], false);
    let page = feed(&t, &f, "?kinds=personalBest").await;
    assert_eq!(page["items"][0]["id"], first_id.as_str());

    // A second PB the same day replaces the first (new id, new score, not first).
    assert_eq!(submit(&t, &sam, &g, 8000).await["personalBest"], true);
    assert_eq!(event_count(&t, &g, "personalBest").await, 1);
    let page = feed(&t, &f, "?kinds=personalBest").await;
    let item = &page["items"][0];
    assert_ne!(item["id"], first_id.as_str());
    assert_eq!(item["score"]["value"], 8000);
    assert_eq!(item["score"]["first"], false);

    // A PB on another day is a separate row.
    sqlx::query("UPDATE activity_events SET day = '2020-01-01' WHERE actor_id = ?")
        .bind(&sam_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    submit(&t, &sam, &g, 7000).await;
    assert_eq!(event_count(&t, &g, "personalBest").await, 2);

    // Unpublished game (owner's preview): no events.
    let hidden = game(&t, &owner, false).await;
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{hidden}/scores"),
            Some(&sam),
            json!({ "score": 1 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    submit(&t, &owner, &hidden, 1).await;
    assert_eq!(event_count(&t, &hidden, "personalBest").await, 0);
}

#[tokio::test]
async fn achievement_events_coalesce_and_follow_definitions() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (sam, _) = t.register("sam").await;
    let (f, _) = t.register("fan").await;
    follow_ok(&t, &f, "sam").await;
    let defs = json!([
        {"id": "a1", "name": "Flawless", "icon": "assets/ach.png"},
        {"id": "a2", "name": "Second"},
        {"id": "a3", "name": "Third", "description": "Do three"},
    ]);
    let g = create_with(&t, &owner, &bundle_with(&manifest(defs)), true).await;

    unlock(&t, &owner, &g, "a1").await;
    assert_eq!(event_count(&t, &g, "achievementUnlocked").await, 0);

    unlock(&t, &sam, &g, "a1").await;
    let page = feed(&t, &f, "").await;
    let item = &page["items"][0];
    assert_eq!(item["kind"], "achievementUnlocked");
    assert_eq!(
        item["achievement"],
        json!({ "id": "a1", "name": "Flawless", "description": "",
                "iconUrl": format!("/games/{g}/files/assets/ach.png"), "count": 1 })
    );
    assert_eq!(item["score"], Value::Null);
    // Repeat unlock (new: false) doesn't count.
    unlock(&t, &sam, &g, "a1").await;
    unlock(&t, &sam, &g, "a2").await;
    unlock(&t, &sam, &g, "a3").await;
    assert_eq!(event_count(&t, &g, "achievementUnlocked").await, 1);
    let page = feed(&t, &f, "").await;
    let ach = &page["items"][0]["achievement"];
    assert_eq!(
        (ach["id"].as_str(), ach["count"].as_i64()),
        (Some("a3"), Some(3))
    );
    assert_eq!(ach["description"], "Do three");

    // A bundle replace dropping the latest definition hides the event (not deleted).
    let defs2 = json!([{"id": "a1", "name": "Flawless"}, {"id": "a2", "name": "Second"}]);
    let r = replace(&t, &owner, &g, &bundle_with(&manifest(defs2))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(event_count(&t, &g, "achievementUnlocked").await, 1);
    let page = feed(&t, &f, "").await;
    assert!(!kinds_of(&page).contains(&"achievementUnlocked".to_string()));
}

#[tokio::test]
async fn event_write_failure_never_fails_request() {
    // The writers are best effort: with the events table gone, every hooked endpoint still
    // succeeds (the failure is only logged).
    let t = setup().await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    let defs = json!([{"id": "a1", "name": "One"}]);
    let g = create_with(&t, &a, &bundle_with(&manifest(defs.clone())), true).await;
    sqlx::query("DROP TABLE activity_events")
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = replace(&t, &a, &g, &bundle_with(&manifest(defs.clone()))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["version"], 2);
    submit(&t, &b, &g, 10).await;
    assert_eq!(unlock(&t, &b, &g, "a1").await["new"], true);
    let g2 = create_with(&t, &a, &bundle_with(&manifest(defs)), true).await;
    let g3 = game(&t, &a, false).await;
    set_published(&t, &a, &g3, true).await;
    // The main writes went through.
    let r = t.get(&format!("/api/games/{g2}"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.get(&format!("/api/games/{g3}"), None).await.json()["published"],
        true
    );
}

#[tokio::test]
async fn migration_backfill_sql() {
    let t = setup().await;
    let (a, _) = t.register("alice").await;
    let g1 = game(&t, &a, true).await;
    let g2 = game(&t, &a, true).await;
    let hidden = game(&t, &a, false).await;
    // Simulate a pre-migration DB: no events yet.
    sqlx::query("DELETE FROM activity_events")
        .execute(&t.state.db)
        .await
        .unwrap();
    let sql = include_str!("../migrations/0005_f002.sql");
    let backfill = &sql[sql.find("-- Backfill").unwrap()..];
    sqlx::raw_sql(backfill).execute(&t.state.db).await.unwrap();
    let mut rows: Vec<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT game_id, kind, version FROM activity_events ORDER BY id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    rows.sort();
    let mut want = vec![
        (g1, "gamePublished".to_string(), Some(1)),
        (g2, "gamePublished".to_string(), Some(1)),
    ];
    want.sort();
    assert_eq!(rows, want);
    // Ids follow created_at.
    let ordered: Vec<String> =
        sqlx::query_scalar("SELECT e.created_at FROM activity_events e ORDER BY e.id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert!(ordered.windows(2).all(|w| w[0] <= w[1]));
    assert_eq!(event_count(&t, &hidden, "gamePublished").await, 0);
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn feed_sources_and_visibility() {
    let t = setup_with(|c| c.admin_usernames = vec!["mod".into()]).await;
    let (admin, _) = t.register("mod").await;
    let (me, _) = t.register("viewer").await;
    let (followed, _) = t.register("followed").await;
    let (stranger, _) = t.register("stranger").await;
    follow_ok(&t, &me, "followed").await;

    let f1 = game(&t, &followed, true).await;
    let s1 = game(&t, &stranger, true).await; // not shown
    let s_fav = game(&t, &stranger, true).await; // favorited: publish/update shown
    favorite(&t, &me, &s_fav).await;
    let mine = game(&t, &me, true).await; // own events never shown
    replace(&t, &me, &mine, &valid_bundle()).await;
    // A stranger's PB on a favorited game is not shown (only publish/update kinds).
    submit(&t, &stranger, &f1, 5).await;
    let (other, _) = t.register("other").await;
    submit(&t, &other, &s_fav, 5).await;
    // The followed user's PB on my game is shown.
    submit(&t, &followed, &mine, 7).await;
    // A favorited game's update.
    replace(&t, &stranger, &s_fav, &valid_bundle()).await;

    let page = feed(&t, &me, "").await;
    let items = page["items"].as_array().unwrap();
    let summary: Vec<(String, String, String)> = items
        .iter()
        .map(|i| {
            (
                i["kind"].as_str().unwrap().to_string(),
                i["game"]["id"].as_str().unwrap().to_string(),
                i["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let s = |k: &str, g: &str, r: &str| (k.to_string(), g.to_string(), r.to_string());
    assert_eq!(
        summary,
        vec![
            s("gameUpdated", &s_fav, "favorite"),
            s("personalBest", &mine, "following"),
            s("gamePublished", &s_fav, "favorite"),
            s("gamePublished", &f1, "following"),
        ]
    );
    assert!(page["nextCursor"].is_null());
    assert!(items[0]["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(items[3]["actor"]["username"], "followed");
    assert_eq!(items[3]["game"]["title"], "Game");
    assert!(!summary.iter().any(|(_, g, _)| g == &s1));

    // Following the favorited game's owner too → reason "following".
    follow_ok(&t, &me, "stranger").await;
    let page = feed(&t, &me, "?kinds=gameUpdated").await;
    assert_eq!(page["items"][0]["reason"], "following");
    unfollow(&t, Some(&me), "stranger").await;

    // Unpublishing (owner) hides every event about the game; re-publishing shows them again.
    set_published(&t, &followed, &f1, false).await;
    let page = feed(&t, &me, "").await;
    assert!(
        !page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["game"]["id"] == f1.as_str())
    );
    set_published(&t, &followed, &f1, true).await;
    assert_eq!(
        feed(&t, &me, "").await["items"].as_array().unwrap().len(),
        4
    );

    // Moderation unpublish hides it too.
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            Some(&me),
            json!({"targetType": "game", "targetId": s_fav, "reason": "spam"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rep = r.json()["id"].as_str().unwrap().to_string();
    let r = t
        .json(
            Method::POST,
            &format!("/api/admin/reports/{rep}/resolve"),
            Some(&admin),
            json!({ "action": "unpublish" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let page = feed(&t, &me, "").await;
    assert_eq!(kinds_of(&page), ["personalBest", "gamePublished"], "{page}");

    // Deleting a game removes its events.
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{f1}"),
            Some(&followed),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(event_count(&t, &f1, "gamePublished").await, 0);
    assert_eq!(kinds_of(&feed(&t, &me, "").await), ["personalBest"]);

    // Anonymous → 401.
    assert_eq!(
        t.get("/api/feed", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.get("/api/feed/suggestions", None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn feed_cursor_paging_and_params() {
    let t = setup().await;
    let (me, _) = t.register("viewer").await;
    let (a, _) = t.register("alice").await;
    follow_ok(&t, &me, "alice").await;
    let mut games = Vec::new();
    for _ in 0..7 {
        games.push(game(&t, &a, true).await);
    }
    replace(&t, &a, &games[0], &valid_bundle()).await;

    // Pages of 3 without duplicates or gaps.
    let mut seen: Vec<i64> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let q = match &cursor {
            Some(c) => format!("?limit=3&cursor={c}"),
            None => "?limit=3".to_string(),
        };
        let page = feed(&t, &me, &q).await;
        pages += 1;
        for i in page["items"].as_array().unwrap() {
            seen.push(i["id"].as_str().unwrap().parse().unwrap());
        }
        match page["nextCursor"].as_str() {
            Some(c) => {
                assert_eq!(c, page["items"][2]["id"].as_str().unwrap());
                cursor = Some(c.to_string());
            }
            None => break,
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen.len(), 8);
    let mut sorted = seen.clone();
    sorted.sort_unstable_by(|x, y| y.cmp(x));
    sorted.dedup();
    assert_eq!(seen, sorted, "strictly descending, unique");
    let all: Vec<i64> = sqlx::query_scalar("SELECT id FROM activity_events ORDER BY id DESC")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert_eq!(seen, all);
    let set: HashSet<i64> = seen.iter().copied().collect();
    assert_eq!(set.len(), 8);

    // Exactly `limit` items left → nextCursor null.
    let page = feed(&t, &me, "?limit=8").await;
    assert!(page["nextCursor"].is_null());
    // Default limit 20; clamped to 1..50.
    assert_eq!(
        feed(&t, &me, "").await["items"].as_array().unwrap().len(),
        8
    );
    assert_eq!(
        feed(&t, &me, "?limit=0").await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        feed(&t, &me, "?limit=999").await["items"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    // kinds filter.
    let page = feed(&t, &me, "?kinds=gameUpdated").await;
    assert_eq!(kinds_of(&page), ["gameUpdated"]);
    let page = feed(&t, &me, "?kinds=gamePublished,gameUpdated").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 8);
    assert_eq!(
        feed(&t, &me, "?kinds=").await["items"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    assert_eq!(
        feed(&t, &me, "?kinds=personalBest").await["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    for bad in [
        "?cursor=abc",
        "?cursor=0",
        "?cursor=-5",
        "?cursor=1.5",
        "?cursor=99999999999999999999",
        "?limit=ten",
        "?limit=2.5",
        "?kinds=gamePublished,bogus",
        "?kinds=commented",
    ] {
        let r = t.get(&format!("/api/feed{bad}"), Some(&me)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}: {}", r.text());
        assert_eq!(r.error_code(), "bad_request");
    }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn suggestions_ranking_and_exclusions() {
    let t = setup().await;
    let (me, _) = t.register("viewer").await;
    // Creators c1..c8, each with a published game; plays rank the "popular" fill.
    let mut toks = Vec::new();
    let mut gids = Vec::new();
    for i in 1..=8 {
        let (tok, _) = t.register(&format!("cre{i}")).await;
        let g = game(&t, &tok, true).await;
        sqlx::query("UPDATE games SET plays = ? WHERE id = ?")
            .bind(i * 10)
            .bind(&g)
            .execute(&t.state.db)
            .await
            .unwrap();
        toks.push(tok);
        gids.push(g);
    }
    // c2 owns a second published game; cre1 is followed already.
    let c2_second = game(&t, &toks[1], true).await;
    follow_ok(&t, &me, "cre1").await;
    // A user with only an unpublished game, and my own published game.
    let (nogame, _) = t.register("hidden").await;
    game(&t, &nogame, false).await;
    let my_game = game(&t, &me, true).await;
    favorite(&t, &me, &my_game).await;

    // Favorites: c3 once (older), c2 twice, c1 (followed → excluded).
    favorite(&t, &me, &gids[2]).await;
    favorite(&t, &me, &gids[1]).await;
    favorite(&t, &me, &c2_second).await;
    favorite(&t, &me, &gids[0]).await;

    let r = t.get("/api/feed/suggestions", Some(&me)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let list = r.json();
    let got: Vec<(String, String, i64)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["user"]["username"].as_str().unwrap().to_string(),
                s["reason"].as_str().unwrap().to_string(),
                s["games"].as_i64().unwrap(),
            )
        })
        .collect();
    let e = |u: &str, r: &str, g: i64| (u.to_string(), r.to_string(), g);
    assert_eq!(
        got,
        vec![
            e("cre2", "favorited", 2),
            e("cre3", "favorited", 1),
            e("cre8", "popular", 1),
            e("cre7", "popular", 1),
            e("cre6", "popular", 1),
            e("cre5", "popular", 1),
        ]
    );
    assert!(list[0]["user"]["displayName"].is_string());

    // A brand-new user only gets popular creators.
    let (fresh, _) = t.register("fresh").await;
    let list = t.get("/api/feed/suggestions", Some(&fresh)).await.json();
    assert_eq!(list.as_array().unwrap().len(), 6);
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|s| s["reason"] == "popular")
    );
    // Ranked by total plays across published games.
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["user"]["username"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["cre8", "cre7", "cre6", "cre5", "cre4", "cre3"]);
    // Everyone followed → nothing (viewer itself is never suggested).
    let all: Vec<String> = (1..=8).map(|i| format!("cre{i}")).collect();
    for u in &all {
        follow_ok(&t, &fresh, u).await;
    }
    follow_ok(&t, &fresh, "viewer").await;
    let list = t.get("/api/feed/suggestions", Some(&fresh)).await.json();
    assert_eq!(list, json!([]));
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

#[tokio::test]
async fn follow_and_feed_rate_limits() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (a, _) = t.register("alice").await;
    t.register("bob").await;
    for i in 0..60 {
        let r = if i % 2 == 0 {
            follow(&t, Some(&a), "bob").await
        } else {
            unfollow(&t, Some(&a), "bob").await
        };
        assert_eq!(r.status, StatusCode::OK, "{i}");
    }
    let r = follow(&t, Some(&a), "bob").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());

    for i in 0..60 {
        let path = if i % 2 == 0 {
            "/api/feed"
        } else {
            "/api/feed/suggestions"
        };
        assert_eq!(t.get(path, Some(&a)).await.status, StatusCode::OK, "{i}");
    }
    let r = t.get("/api/feed", Some(&a)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    // Lists and profiles stay unlimited.
    for _ in 0..70 {
        assert_eq!(
            t.get("/api/users/bob/followers", None).await.status,
            StatusCode::OK
        );
    }
}
