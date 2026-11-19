//! REVIEW-2026-11-19-12 backend findings:
//! - M1: `GET /api/creators` and `/api/creators/spotlight` read a periodic in-memory snapshot
//!   (`creators_snapshot`), refreshed every `CREATORS_TTL_SECS`; only `isFollowing` is live.
//! - L4: the F031 reply cap and lock guard under concurrency (several pool connections plus a
//!   separately held writer connection).

mod common;

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::*;
use serde_json::{Value, json};
use tower::ServiceExt;
use webgame_server::routes::creators::creator_sql;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn exec(t: &TestApp, sql: &str) {
    sqlx::query(sql).execute(&t.state.db).await.unwrap();
}

async fn insert_user(t: &TestApp, uid: &str, username: &str) {
    sqlx::query(
        "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
         display_name, created_at) VALUES (?1, ?2, ?3, ?1, ?1, 'h', ?2, '2026-01-01T00:00:00.000Z')",
    )
    .bind(uid)
    .bind(username)
    .bind(username.to_lowercase())
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn insert_game(
    t: &TestApp,
    gid: &str,
    owner: &str,
    plays: i64,
    first: &str,
    last: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, updated_at, \
         first_published_at, last_updated_at, published, plays, actions_json, controls_hint) \
         VALUES (?1, ?2, ?1, 'main.js', 800, 600, ?3, ?3, ?3, ?4, 1, ?5, '[]', '')",
    )
    .bind(gid)
    .bind(owner)
    .bind(first)
    .bind(last)
    .bind(plays)
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn insert_follow(t: &TestApp, follower: &str, followee: &str) {
    sqlx::query(
        "INSERT INTO follows (follower_id, followee_id, created_at) \
         VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
    )
    .bind(follower)
    .bind(followee)
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn get_ok(t: &TestApp, uri: &str, tok: Option<&str>) -> Value {
    let r = t.get(uri, tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

fn usernames(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["user"]["username"].as_str().unwrap().to_string())
        .collect()
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

// ---------------------------------------------------------------------------
// M1: creators snapshot
// ---------------------------------------------------------------------------

/// With a TTL, new data shows up only after the next refresh; tests force one with
/// `state.creators.refresh_now`.
#[tokio::test]
async fn creators_are_served_from_the_snapshot_until_the_next_refresh() {
    let t = setup_with(|c| c.creators_ttl = Duration::from_secs(3600)).await;
    // Startup built the (empty) snapshot.
    assert_eq!(t.state.creators.refresh_count(), 1);
    let (ava_tok, _) = t.register("ava").await;
    t.create_game(&ava_tok, "Dodge", "arcade", true).await;

    // Stale: the startup snapshot had no creators.
    let v = get_ok(&t, "/api/creators", None).await;
    assert_eq!(v["total"], 0);
    let s = get_ok(&t, "/api/creators/spotlight", None).await;
    assert!(s["creator"].is_null(), "{s}");
    assert_eq!(t.state.creators.refresh_count(), 1, "reads never refresh");

    assert!(t.state.creators.refresh_now(&t.state.db).await);
    assert_eq!(t.state.creators.refresh_count(), 2);
    let v = get_ok(&t, "/api/creators", None).await;
    assert_eq!(v["total"], 1);
    assert_eq!(usernames(&v), ["ava"]);
    assert_eq!(v["items"][0]["followers"], 0);
    let s = get_ok(&t, "/api/creators/spotlight", None).await;
    assert_eq!(s["creator"]["user"]["username"], "ava");
    assert_eq!(s["games"].as_array().unwrap().len(), 1);

    // A follow: the count waits for the refresh, `isFollowing` is live.
    let (leo_tok, _) = t.register("leo").await;
    follow(&t, &leo_tok, "ava").await;
    let v = get_ok(&t, "/api/creators", Some(&leo_tok)).await;
    assert_eq!(v["items"][0]["followers"], 0, "stale count");
    assert_eq!(v["items"][0]["isFollowing"], true, "live per viewer");
    let s = get_ok(&t, "/api/creators/spotlight", Some(&leo_tok)).await;
    assert_eq!(s["creator"]["isFollowing"], true);
    assert_eq!(s["creator"]["followers"], 0);

    t.state.creators.refresh_now(&t.state.db).await;
    let v = get_ok(&t, "/api/creators", Some(&leo_tok)).await;
    assert_eq!(v["items"][0]["followers"], 1);
}

/// `CREATORS_TTL_SECS = 0` (the test default): every read rebuilds first, no startup build.
#[tokio::test]
async fn ttl_zero_rebuilds_on_every_read() {
    let t = setup().await;
    assert!(t.state.config.creators_ttl.is_zero());
    assert_eq!(t.state.creators.refresh_count(), 0);
    get_ok(&t, "/api/creators", None).await;
    get_ok(&t, "/api/creators?sort=new", None).await;
    get_ok(&t, "/api/creators/spotlight", None).await;
    assert_eq!(t.state.creators.refresh_count(), 3);
}

/// The in-memory orders equal the F035 SQL `ORDER BY` strings, ties included.
#[tokio::test]
async fn snapshot_orders_match_the_sql_orders() {
    let t = setup().await;
    // Names chosen so the case-insensitive tie-break differs from the id order.
    let users = [
        ("u1", "Zed"),
        ("u2", "amy"),
        ("u3", "Bob"),
        ("u4", "carl"),
        ("u5", "Dora"),
        ("u6", "eve"),
    ];
    for (id, name) in users {
        insert_user(&t, id, name).await;
    }
    // Ties on followers and plays (popular), on last activity (active) and on first publish
    // (new).
    insert_game(&t, "g1", "u1", 5, "2026-03-01T00:00:00.000Z", None).await;
    insert_game(&t, "g2", "u2", 5, "2026-03-01T00:00:00.000Z", None).await;
    insert_game(
        &t,
        "g3",
        "u3",
        9,
        "2026-03-02T00:00:00.000Z",
        Some("2026-03-09T00:00:00.000Z"),
    )
    .await;
    insert_game(
        &t,
        "g4",
        "u4",
        0,
        "2026-03-02T00:00:00.000Z",
        Some("2026-03-09T00:00:00.000Z"),
    )
    .await;
    insert_game(&t, "g5", "u5", 2, "2026-03-03T00:00:00.000Z", None).await;
    insert_game(&t, "g6", "u5", 2, "2026-02-01T00:00:00.000Z", None).await;
    insert_follow(&t, "u6", "u1").await;
    insert_follow(&t, "u6", "u2").await;
    insert_follow(&t, "u1", "u5").await;

    for (sort, order) in [
        (
            "popular",
            "followers DESC, c.plays DESC, u.username_lower ASC",
        ),
        ("active", "c.last_act DESC, u.username_lower ASC"),
        ("new", "c.first_pub DESC, u.username_lower ASC"),
    ] {
        let want: Vec<String> = sqlx::query_scalar::<_, String>(&format!(
            "SELECT u_username FROM ({})",
            creator_sql(false, order)
        ))
        .bind(-1_i64)
        .bind(0_i64)
        .fetch_all(&t.state.db)
        .await
        .unwrap();
        assert_eq!(want.len(), 5);
        let got = get_ok(&t, &format!("/api/creators?sort={sort}"), None).await;
        assert_eq!(usernames(&got), want, "{sort}");
        assert_eq!(got["total"], 5);
        // Paged reads give the same order.
        let mut paged = Vec::new();
        for page in 1..=3 {
            paged.extend(usernames(
                &get_ok(
                    &t,
                    &format!("/api/creators?sort={sort}&perPage=2&page={page}"),
                    None,
                )
                .await,
            ));
        }
        assert_eq!(paged, want, "{sort} paged");
    }
    let empty = get_ok(&t, "/api/creators?page=4&perPage=2", None).await;
    assert_eq!(empty["items"], json!([]));
    assert_eq!(empty["total"], 5);
    // The spotlight's eligible set is the same snapshot, by id.
    let s = get_ok(&t, "/api/creators/spotlight", None).await;
    assert!(s["creator"]["user"]["id"].is_string());
}

/// Cost before and after M1 on a large catalogue. Run on demand:
/// `cargo test --test review12 -- --ignored --nocapture creators_cost`.
#[tokio::test]
#[ignore]
async fn creators_cost() {
    let t = setup_with(|c| c.creators_ttl = Duration::from_secs(3600)).await;
    exec(
        &t,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) \
         INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
           display_name, bio, created_at) \
         SELECT printf('u%05d', i), printf('user%05d', i), printf('user%05d', i), \
                printf('e%05d', i), printf('e%05d', i), 'h', printf('User %d', i), 'bio', \
                '2026-01-01T00:00:00.000Z' FROM n",
    )
    .await;
    exec(
        &t,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000) \
         INSERT INTO games (id, owner_id, title, entry, width, height, created_at, updated_at, \
           first_published_at, published, plays, actions_json, controls_hint) \
         SELECT printf('g%06d', i), printf('u%05d', 1 + (i * 7919) % 10000), 't', 'main.js', \
                800, 600, printf('2026-01-%02dT00:00:00.000Z', 1 + i % 28), \
                '2026-01-01T00:00:00.000Z', printf('2026-01-%02dT00:00:00.000Z', 1 + i % 28), \
                CASE WHEN i % 5 = 0 THEN 0 ELSE 1 END, i % 997, '[]', '' FROM n",
    )
    .await;
    exec(
        &t,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) \
         INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) \
         SELECT printf('u%05d', 1 + i % 10000), printf('u%05d', 1 + (i * 31 + i / 10000) % 10000), \
                '2026-01-01T00:00:00.000Z' FROM n \
         WHERE 1 + i % 10000 <> 1 + (i * 31 + i / 10000) % 10000",
    )
    .await;
    exec(&t, "ANALYZE").await;

    let runs = 20;
    let sql = creator_sql(false, "followers DESC, c.plays DESC, u.username_lower ASC");
    let start = Instant::now();
    for _ in 0..runs {
        sqlx::query(&sql)
            .bind(24_i64)
            .bind(0_i64)
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    }
    let before = start.elapsed() / runs;

    let start = Instant::now();
    assert!(t.state.creators.refresh_now(&t.state.db).await);
    let refresh = start.elapsed();

    let (tok, _) = t.register("viewer").await;
    let start = Instant::now();
    for i in 0..runs {
        let uri = format!("/api/creators?sort=active&page={}", 1 + i * 7);
        let r = t.get(&uri, Some(&tok)).await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let after = start.elapsed() / runs;
    let total = get_ok(&t, "/api/creators", None).await["total"].clone();
    println!(
        "creators={total}: before (SQL page per request) {before:?}; \
         refresh {refresh:?}; after (snapshot request, signed in) {after:?}"
    );
}

// ---------------------------------------------------------------------------
// L4: F031 reply cap and lock under concurrency
// ---------------------------------------------------------------------------

const CAP_MESSAGE: &str = "This post has reached 200 replies";
const LOCKED_MESSAGE: &str = "Replies are turned off for this post";

async fn text_post(t: &TestApp, tok: &str) -> String {
    let r = t
        .json(
            Method::POST,
            "/api/posts",
            Some(tok),
            json!({ "body": "Race" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

/// `n` replies by `author` inserted directly (the counter trigger keeps `reply_count`).
async fn fill_replies(t: &TestApp, pid: &str, author: &str, n: i64) {
    sqlx::query(
        "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?3) \
         INSERT INTO post_replies (id, post_id, author_id, body, created_at) \
         SELECT printf('fill-%03d', i), ?1, ?2, 'x', printf('2026-01-01T00:00:%02d.%03dZ', i / 1000, i % 1000) \
         FROM k",
    )
    .bind(pid)
    .bind(author)
    .bind(n)
    .execute(&t.state.db)
    .await
    .unwrap();
}

/// A reply request; the router is cloned so many can run at once on their own connections.
fn reply_req(tok: &str, pid: &str, text: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(format!("/api/posts/{pid}/replies"))
        .header("host", "localhost:8080")
        .header("authorization", format!("Bearer {tok}"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "body": text }).to_string()))
        .unwrap()
}

async fn status_and_message(res: axum::response::Response) -> (StatusCode, String) {
    use http_body_util::BodyExt;
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (
        status,
        v["error"]["message"].as_str().unwrap_or("").to_string(),
    )
}

async fn reply_count(t: &TestApp, pid: &str) -> (i64, i64) {
    sqlx::query_as(
        "SELECT reply_count, (SELECT COUNT(*) FROM post_replies WHERE post_id = ?1) \
         FROM posts WHERE id = ?1",
    )
    .bind(pid)
    .fetch_one(&t.state.db)
    .await
    .unwrap()
}

/// Ten replies race for the last slot at 199: exactly one wins.
#[tokio::test]
async fn concurrent_replies_at_199_never_exceed_the_cap() {
    let t = setup().await; // RATE_LIMIT off
    let (mia, mia_id) = t.register("mia").await;
    let pid = text_post(&t, &mia).await;
    fill_replies(&t, &pid, &mia_id, 199).await;
    assert_eq!(reply_count(&t, &pid).await, (199, 199));

    let mut tokens = Vec::new();
    for i in 0..10 {
        tokens.push(t.register(&format!("racer{i}")).await.0);
    }
    let mut set = tokio::task::JoinSet::new();
    for (i, tok) in tokens.iter().enumerate() {
        let router = t.router.clone();
        let req = reply_req(tok, &pid, &format!("last {i}"));
        set.spawn(async move { status_and_message(router.oneshot(req).await.unwrap()).await });
    }
    let (mut created, mut capped) = (0, 0);
    while let Some(res) = set.join_next().await {
        match res.unwrap() {
            (StatusCode::CREATED, _) => created += 1,
            (StatusCode::UNPROCESSABLE_ENTITY, m) => {
                assert_eq!(m, CAP_MESSAGE);
                capped += 1;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    t.state.fan_out.idle().await;
    assert_eq!((created, capped), (1, 9));
    assert_eq!(reply_count(&t, &pid).await, (200, 200));
}

/// A lock that commits while replies wait for the write lock: the guarded insert re-checks it,
/// so no non-moderator reply is stored, and the post's author still gets through.
#[tokio::test]
async fn a_lock_committed_mid_request_stops_waiting_replies() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let pid = text_post(&t, &mia).await;
    let mut tokens = Vec::new();
    for i in 0..5 {
        tokens.push(t.register(&format!("racer{i}")).await.0);
    }

    // Hold the write lock on a separate connection, so the replies pass the unlocked
    // pre-check and then wait in `BEGIN IMMEDIATE` (busy_timeout).
    let mut writer = t.state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let mut set = tokio::task::JoinSet::new();
    for (i, tok) in tokens.iter().enumerate() {
        let router = t.router.clone();
        let req = reply_req(tok, &pid, &format!("racing {i}"));
        set.spawn(async move {
            (
                false,
                status_and_message(router.oneshot(req).await.unwrap()).await,
            )
        });
    }
    {
        let router = t.router.clone();
        let req = reply_req(&mia, &pid, "author");
        set.spawn(async move {
            (
                true,
                status_and_message(router.oneshot(req).await.unwrap()).await,
            )
        });
    }
    // Give the requests time to reach the write lock, then lock the post and release it.
    tokio::time::sleep(Duration::from_millis(300)).await;
    sqlx::query("UPDATE posts SET locked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(&pid)
        .execute(&mut *writer)
        .await
        .unwrap();
    writer.commit().await.unwrap();

    let mut author_ok = false;
    while let Some(res) = set.join_next().await {
        match res.unwrap() {
            (true, (StatusCode::CREATED, _)) => author_ok = true,
            (false, (StatusCode::UNPROCESSABLE_ENTITY, m)) => assert_eq!(m, LOCKED_MESSAGE),
            other => panic!("unexpected {other:?}"),
        }
    }
    t.state.fan_out.idle().await;
    assert!(author_ok);
    assert_eq!(
        reply_count(&t, &pid).await,
        (1, 1),
        "only the author's reply"
    );
}

/// Replies and a lock request in flight together: every reply is either stored (201) or
/// refused with the lock message, the counter matches, and after the lock nobody else gets in.
#[tokio::test]
async fn replies_racing_a_lock_request_stay_consistent() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let pid = text_post(&t, &mia).await;
    let mut tokens = Vec::new();
    for i in 0..8 {
        tokens.push(t.register(&format!("racer{i}")).await.0);
    }
    let mut set = tokio::task::JoinSet::new();
    for (i, tok) in tokens.iter().enumerate() {
        let router = t.router.clone();
        let req = reply_req(tok, &pid, &format!("racing {i}"));
        set.spawn(async move { status_and_message(router.oneshot(req).await.unwrap()).await });
        if i == 3 {
            let router = t.router.clone();
            let req = Request::builder()
                .method(Method::PUT)
                .uri(format!("/api/posts/{pid}/lock"))
                .header("host", "localhost:8080")
                .header("authorization", format!("Bearer {mia}"))
                .body(Body::empty())
                .unwrap();
            set.spawn(async move {
                let res = router.oneshot(req).await.unwrap();
                assert_eq!(res.status(), StatusCode::OK);
                (StatusCode::OK, "lock".to_string())
            });
        }
    }
    let mut created = 0;
    while let Some(res) = set.join_next().await {
        match res.unwrap() {
            (StatusCode::OK, m) => assert_eq!(m, "lock"),
            (StatusCode::CREATED, _) => created += 1,
            (StatusCode::UNPROCESSABLE_ENTITY, m) => assert_eq!(m, LOCKED_MESSAGE),
            other => panic!("unexpected {other:?}"),
        }
    }
    t.state.fan_out.idle().await;
    assert_eq!(reply_count(&t, &pid).await, (created, created));
    let late = t
        .router
        .clone()
        .oneshot(reply_req(&tokens[0], &pid, "late"))
        .await
        .unwrap();
    assert_eq!(
        status_and_message(late).await,
        (StatusCode::UNPROCESSABLE_ENTITY, LOCKED_MESSAGE.to_string())
    );
    assert_eq!(reply_count(&t, &pid).await, (created, created));
}
