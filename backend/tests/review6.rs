//! Review round 6 (docs/reviews/REVIEW-2026-11-16-6.md), backend: M1 (no fixed JWT fallback
//! secret), L2 (trigger-maintained `comments.hearts`, index-backed Top sort, `CommentList` rate
//! limit) and L3 (mutes on games the user can no longer see don't count toward the cap).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

async fn scalar(t: &TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
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

async fn send_empty(t: &TestApp, method: Method, uri: &str, tok: Option<&str>) -> Resp {
    t.send(method, uri, tok, None, vec![], &[]).await
}

async fn heart(t: &TestApp, method: Method, tok: &str, cid: &str) -> Value {
    let r = send_empty(t, method, &format!("/api/comments/{cid}/heart"), Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn stored_hearts(t: &TestApp, cid: &str) -> i64 {
    scalar(t, "SELECT hearts FROM comments WHERE id = ?", cid).await
}

async fn counted_hearts(t: &TestApp, cid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM comment_hearts WHERE comment_id = ?",
        cid,
    )
    .await
}

fn ids(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// M1: no fixed fallback secret
// ---------------------------------------------------------------------------

#[tokio::test]
async fn m1_no_shared_default_secret() {
    let a = setup().await;
    let b = setup().await;
    assert_eq!(a.state.config.jwt_secret.len(), 64);
    assert_ne!(a.state.config.jwt_secret, b.state.config.jwt_secret);

    let (tok, uid) = a.register("ava").await;
    assert_eq!(
        a.get("/api/auth/me", Some(&tok)).await.status,
        StatusCode::OK
    );
    // A token from another process (a restart, or anyone with the repo) doesn't verify.
    b.register("ava").await;
    let r = b.get("/api/auth/me", Some(&tok)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // The old published dev default is gone.
    let forged =
        webgame_server::auth::create_token("dev-insecure-jwt-secret-change-me", &uid).unwrap();
    assert_eq!(
        a.get("/api/auth/me", Some(&forged)).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn m1_explicit_secret_is_used() {
    let t = setup_with(|c| c.jwt_secret = "explicit-test-secret".into()).await;
    let (_, uid) = t.register("ava").await;
    let tok = webgame_server::auth::create_token("explicit-test-secret", &uid).unwrap();
    let r = t.get("/api/auth/me", Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------------------
// L2: hearts counter, Top sort, rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn l2_hearts_counter_follows_every_write_path() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let (zoe, zoe_id) = t.register("zoe").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let root = comment(&t, &mia, &g, "root", None).await;
    let reply = comment(&t, &mia, &g, "reply", Some(&root)).await;
    assert_eq!(stored_hearts(&t, &root).await, 0);

    assert_eq!(heart(&t, Method::PUT, &kai, &root).await["hearts"], 1);
    // Idempotent re-heart: INSERT OR IGNORE doesn't fire the trigger.
    assert_eq!(heart(&t, Method::PUT, &kai, &root).await["hearts"], 1);
    assert_eq!(heart(&t, Method::PUT, &zoe, &root).await["hearts"], 2);
    assert_eq!(heart(&t, Method::PUT, &zoe, &reply).await["hearts"], 1);
    assert_eq!(stored_hearts(&t, &root).await, 2);
    assert_eq!(stored_hearts(&t, &reply).await, 1);

    assert_eq!(heart(&t, Method::DELETE, &kai, &root).await["hearts"], 1);
    // Idempotent unheart.
    assert_eq!(heart(&t, Method::DELETE, &kai, &root).await["hearts"], 1);
    assert_eq!(stored_hearts(&t, &root).await, 1);

    // FK cascade from the hearter's account fires the delete trigger.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&zoe_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stored_hearts(&t, &root).await, 0);
    assert_eq!(stored_hearts(&t, &reply).await, 0);
    for c in [&root, &reply] {
        assert_eq!(stored_hearts(&t, c).await, counted_hearts(&t, c).await);
    }

    // The read shape uses the column.
    let r = t.get(&format!("/api/games/{g}/comments"), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["items"][0]["hearts"], 0);

    // Deleting a hearted comment cascades its hearts without error.
    heart(&t, Method::PUT, &kai, &root).await;
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{root}"),
        Some(&mia),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert_eq!(counted_hearts(&t, &root).await, 0);
}

#[tokio::test]
async fn l2_top_sort_order_and_query_plan() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let mut fans = Vec::new();
    for i in 0..3 {
        fans.push(t.register(&format!("fan{i}")).await.0);
    }
    let g = game(&t, &mia, "Space Dodge", true).await;
    let a = comment(&t, &mia, &g, "a", None).await;
    let b = comment(&t, &mia, &g, "b", None).await;
    let c = comment(&t, &mia, &g, "c", None).await;
    let d = comment(&t, &mia, &g, "d", None).await;
    // Same created_at for a/b so the rowid tie-break is exercised.
    sqlx::query("UPDATE comments SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)")
        .bind(&a)
        .bind(&b)
        .execute(&t.state.db)
        .await
        .unwrap();
    for f in &fans {
        heart(&t, Method::PUT, f, &c).await;
    }
    heart(&t, Method::PUT, &fans[0], &a).await;
    heart(&t, Method::PUT, &fans[0], &b).await;
    let r = t
        .get(&format!("/api/games/{g}/comments?sort=top"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    // c (3), then b and a (1 each, same time: newer rowid first), then d (0).
    assert_eq!(
        ids(&v["items"]),
        vec![c.clone(), b.clone(), a.clone(), d.clone()]
    );
    assert_eq!(v["items"][0]["hearts"], 3);
    // Paging keeps the order.
    let r = t
        .get(
            &format!("/api/games/{g}/comments?sort=top&perPage=2&page=2"),
            None,
        )
        .await;
    assert_eq!(ids(&r.json()["items"]), vec![a.clone(), d.clone()]);

    // The planner reads the partial index backwards: no temp B-tree, no full sort.
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(
        "EXPLAIN QUERY PLAN SELECT c.id FROM comments c \
         JOIN users u ON u.id = c.user_id JOIN games g ON g.id = c.game_id \
         LEFT JOIN users r ON r.id = c.reply_to_user_id \
         WHERE c.game_id = ?1 AND c.parent_id IS NULL AND c.pinned_at IS NULL \
         ORDER BY c.hearts DESC, c.created_at DESC, c.rowid DESC LIMIT 20 OFFSET 0",
    )
    .bind(&g)
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    let text: Vec<&str> = plan.iter().map(|p| p.3.as_str()).collect();
    assert!(
        text.iter().any(|d| d.contains("idx_comments_game_hearts")),
        "{text:?}"
    );
    assert!(!text.iter().any(|d| d.contains("TEMP B-TREE")), "{text:?}");
}

#[tokio::test]
async fn l2_migration_backfills_hearts() {
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
                .filter(|x| x.version <= 17)
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
                 ('g1', 'u1', 'Old', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '', 1)"
            ),
            format!(
                "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) VALUES \
                 ('c1', 'g1', 'u1', 'one', '{ts}', NULL), \
                 ('c2', 'g1', 'u1', 'two', '{ts}', NULL), \
                 ('c3', 'g1', 'u1', 'reply', '{ts}', 'c1')"
            ),
            format!(
                "INSERT INTO comment_hearts (comment_id, user_id, created_at) VALUES \
                 ('c2', 'u2', '{ts}'), ('c2', 'u3', '{ts}'), ('c1', 'u2', '{ts}'), \
                 ('c3', 'u3', '{ts}')"
            ),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        db.close().await;
    }
    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT id, hearts FROM comments ORDER BY id")
        .fetch_all(&state.db)
        .await
        .unwrap();
    assert_eq!(
        rows,
        vec![("c1".into(), 1), ("c2".into(), 2), ("c3".into(), 1)]
    );
    // The triggers are live after the upgrade.
    sqlx::query("DELETE FROM comment_hearts WHERE comment_id = 'c2' AND user_id = 'u2'")
        .execute(&state.db)
        .await
        .unwrap();
    let h: i64 = sqlx::query_scalar("SELECT hearts FROM comments WHERE id = 'c2'")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(h, 1);
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}

#[tokio::test]
async fn l2_comment_list_is_rate_limited() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let uris = [
        format!("/api/games/{g}/comments?sort=top"),
        format!("/api/games/{g}/comments"),
        format!("/api/games/{g}/comments?sort=new&page=3"),
    ];
    // Anonymous: 120 per minute per IP, every sort shares the bucket.
    for i in 0..120 {
        let r = t.get(&uris[i % 3], None).await;
        assert_eq!(r.status, StatusCode::OK, "request {i}: {}", r.text());
    }
    for uri in &uris {
        let r = t.get(uri, None).await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{uri}");
        assert_eq!(r.error_code(), "rate_limited");
        assert!(r.header("retry-after").parse::<u64>().unwrap() >= 1);
    }
    // The limit comes before the visibility lookup.
    let r = t.get("/api/games/nope/comments", None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // A signed-in reader has their own bucket.
    let r = t.get(&uris[0], Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK);
    // Replies are not limited by this bucket.
    let root = comment(&t, &mia, &g, "root", None).await;
    let r = t.get(&format!("/api/comments/{root}/replies"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // The bucket refills (ManualClock).
    t.clock.advance(Duration::from_secs(1));
    let r = t.get(&uris[0], None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------------------
// L3: hidden mutes and the cap
// ---------------------------------------------------------------------------

fn game_mute_uri(gid: &str) -> String {
    format!("/api/notifications/mutes/games/{gid}")
}

async fn mute_rows(t: &TestApp, uid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM notification_mutes WHERE user_id = ?",
        uid,
    )
    .await
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

#[tokio::test]
async fn l3_hidden_mutes_do_not_count_and_can_be_removed() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let hidden = game(&t, &mia, "Later Hidden", true).await;
    let thread_game = game(&t, &mia, "Thread Game", true).await;
    let root = comment(&t, &mia, &thread_game, "root", None).await;
    let fresh = game(&t, &mia, "Fresh", true).await;
    let fresh2 = game(&t, &mia, "Fresh Two", true).await;

    // A game mute and a thread mute through the API, then 498 synthetic own games.
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&hidden), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = send_empty(
        &t,
        Method::PUT,
        &format!("/api/notifications/mutes/threads/{root}"),
        Some(&kai),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let ts = "2026-01-01T00:00:00.000Z";
    sqlx::query(
        "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, updated_at, \
         actions_json, controls_hint) \
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 498) \
         SELECT 'syn' || i, ?1, 'Synthetic ' || i, 'main.js', 800, 600, ?2, ?2, '[]', '' FROM n",
    )
    .bind(&kai_id)
    .bind(ts)
    .execute(&t.state.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notification_mutes (user_id, game_id, thread_id, created_at) \
         SELECT ?1, id, NULL, ?2 FROM games WHERE id LIKE 'syn%'",
    )
    .bind(&kai_id)
    .bind(ts)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert_eq!(mute_rows(&t, &kai_id).await, 500);
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&fresh), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);

    // The creator unpublishes both games: the two mutes vanish from the list and the cap.
    set_published(&t, &mia, &hidden, false).await;
    set_published(&t, &mia, &thread_game, false).await;
    let list = t.get("/api/notifications/mutes", Some(&kai)).await.json();
    assert_eq!(list["total"], 498);
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&fresh), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&fresh2), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(mute_rows(&t, &kai_id).await, 502);
    let list = t.get("/api/notifications/mutes", Some(&kai)).await.json();
    assert_eq!(list["total"], 500);
    // Now at the visible cap again.
    let extra = game(&t, &mia, "Extra", true).await;
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&extra), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);

    // DELETE works whatever the game's visibility.
    let r = send_empty(&t, Method::DELETE, &game_mute_uri(&hidden), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["muted"], false);
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/notifications/mutes/threads/{root}"),
        Some(&kai),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(mute_rows(&t, &kai_id).await, 500);

    // A hidden mute that is kept applies again (and is listed) after a republish.
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&fresh), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK);
    set_published(&t, &mia, &fresh, false).await;
    assert_eq!(
        t.get("/api/notifications/mutes", Some(&kai)).await.json()["total"],
        499
    );
    set_published(&t, &mia, &fresh, true).await;
    assert_eq!(
        t.get("/api/notifications/mutes", Some(&kai)).await.json()["total"],
        500
    );
}
