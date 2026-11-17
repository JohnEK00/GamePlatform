//! Review round 5 (docs/reviews/REVIEW-2026-11-16-5.md), backend: M1 (compression and SPA
//! caching), L5 (tombstones vs the per-recipient cap and the mute), L9 (parked fan-outs are
//! retried; housekeeping runs whatever the trending TTL). The f004 race test is made
//! deterministic in `tests/f004.rs`.

mod common;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::*;
use serde_json::{Value, json};
use webgame_server::notifications::{
    FAN_OUT_MAX_ATTEMPTS, FAN_OUT_UNPARK_EVERY, PER_RECIPIENT_CAP, prune, stamp,
};
use webgame_server::trending::{Housekeeping, OPTIMIZE_EVERY};

const GZIP: (&str, &str) = ("accept-encoding", "gzip, deflate, br");

async fn get_with(t: &TestApp, uri: &str, extra: &[(&str, &str)]) -> Resp {
    t.send(Method::GET, uri, None, None, vec![], extra).await
}

fn is_gzip(r: &Resp) -> bool {
    r.header("content-encoding") == "gzip" && r.body.starts_with(&[0x1f, 0x8b])
}

fn big_js(tag: &str) -> String {
    format!(
        "// {tag}\n{}",
        "export const x = 'hello compression';\n".repeat(200)
    )
}

// ---------------------------------------------------------------------------
// M1: compression, validators and caching
// ---------------------------------------------------------------------------

#[tokio::test]
async fn m1_runtime_is_gzipped_with_weak_etag_and_vary() {
    let js = big_js("engine");
    let t = setup().await;
    std::fs::write(t.state.config.engine_dist.join("engine.js"), &js).unwrap();

    let plain = t.get("/runtime/engine.js", None).await;
    assert_eq!(plain.status, StatusCode::OK);
    assert_eq!(plain.header("content-encoding"), "");
    assert_eq!(plain.body, js.as_bytes());
    let etag = plain.header("etag");
    assert!(etag.starts_with("W/\"rt-"), "{etag}");
    assert!(plain.header("vary").contains("accept-encoding"));

    let gz = get_with(&t, "/runtime/engine.js", &[GZIP]).await;
    assert_eq!(gz.status, StatusCode::OK);
    assert!(is_gzip(&gz));
    assert!(gz.body.len() < js.len() / 4, "{} bytes", gz.body.len());
    assert_eq!(gz.header("content-length"), "");
    assert_eq!(gz.header("etag"), etag);
    assert!(gz.header("vary").contains("accept-encoding"));
    assert_eq!(gz.header("content-type"), "text/javascript; charset=utf-8");
    assert_eq!(gz.header("cache-control"), "no-cache");

    // Revalidation works with the weak tag (and the strong form) for either encoding.
    for inm in [etag.as_str(), etag.trim_start_matches("W/")] {
        let r = get_with(&t, "/runtime/engine.js", &[GZIP, ("if-none-match", inm)]).await;
        assert_eq!(r.status, StatusCode::NOT_MODIFIED, "{inm}");
        assert_eq!(r.header("etag"), etag);
        assert!(r.header("vary").contains("accept-encoding"));
        assert!(r.body.is_empty());
    }
}

async fn create_game_with(t: &TestApp, tok: &str, files: &[(&str, &[u8])]) -> String {
    let zip = make_zip(files);
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(tok),
            &[
                Part::Text("title", "Big"),
                Part::Text("description", "big files"),
                Part::Text("tags", ""),
                Part::Text("published", "true"),
                Part::File("bundle", "game.zip", "application/zip", &zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn m1_game_files_gzip_text_but_not_media() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let js = big_js("main");
    let mut png = png_bytes();
    png.resize(4096, 0);
    let data = format!(
        "{{\"levels\": [{}]}}",
        vec!["[1,2,3,4,5,6,7,8]"; 100].join(",")
    );
    let gid = create_game_with(
        &t,
        &tok,
        &[
            ("game.json", GAME_JSON.as_bytes()),
            ("main.js", js.as_bytes()),
            ("assets/big.png", &png),
            ("data/levels.json", data.as_bytes()),
        ],
    )
    .await;

    for (path, ct) in [
        ("main.js", "text/javascript; charset=utf-8"),
        ("data/levels.json", "application/json; charset=utf-8"),
    ] {
        let r = get_with(&t, &format!("/games/{gid}/files/{path}"), &[GZIP]).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert!(is_gzip(&r), "{path}");
        assert_eq!(r.header("content-type"), ct);
        assert!(r.header("etag").starts_with("W/\"v1-"), "{path}");
        // Security headers survive compression.
        assert_eq!(r.header("x-content-type-options"), "nosniff");
        assert_eq!(r.header("content-security-policy"), "sandbox");
        assert_eq!(r.header("access-control-allow-origin"), "*");
    }

    let r = get_with(&t, &format!("/games/{gid}/files/assets/big.png"), &[GZIP]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-encoding"), "");
    assert_eq!(r.body, png);
    assert_eq!(r.header("content-length"), "4096");
    let etag = r.header("etag");
    assert!(etag.starts_with("\"v1-"), "strong for media: {etag}");
    assert!(!r.header("vary").contains("accept-encoding"));
    let r = get_with(
        &t,
        &format!("/games/{gid}/files/assets/big.png"),
        &[("if-none-match", &etag)],
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert_eq!(r.header("etag"), etag);

    // The API isn't compressed.
    let r = get_with(&t, &format!("/api/games/{gid}"), &[GZIP]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-encoding"), "");
}

#[tokio::test]
async fn m1_spa_caching_maps_and_compression() {
    let web = common::test_dir();
    let index = format!(
        "<!doctype html><html><head><title>WebGame</title></head><body>{}</body></html>",
        "<div id=\"root\"></div>".repeat(40)
    );
    std::fs::create_dir_all(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("index.html"), &index).unwrap();
    std::fs::write(web.path().join("assets/index-abc123.js"), big_js("spa")).unwrap();
    std::fs::write(web.path().join("assets/index-abc123.js.map"), "{}").unwrap();
    std::fs::write(web.path().join("stray.map"), "{}").unwrap();
    let mut logo = png_bytes();
    logo.resize(2048, 0);
    std::fs::write(web.path().join("assets/logo-ff00.png"), &logo).unwrap();
    std::fs::write(web.path().join("robots.txt"), "User-agent: *\n").unwrap();
    let dist = web.path().to_path_buf();
    let t = setup_with(move |c| c.web_dist = Some(dist)).await;

    // Hashed assets: a year, immutable, gzipped.
    let r = get_with(&t, "/assets/index-abc123.js", &[GZIP]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(is_gzip(&r));
    assert_eq!(
        r.header("cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert!(r.header("vary").contains("accept-encoding"));
    let last_modified = r.header("last-modified");
    assert!(!last_modified.is_empty());
    let r = get_with(
        &t,
        "/assets/index-abc123.js",
        &[GZIP, ("if-modified-since", &last_modified)],
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert_eq!(
        r.header("cache-control"),
        "public, max-age=31536000, immutable"
    );

    // Media is not recompressed.
    let r = get_with(&t, "/assets/logo-ff00.png", &[GZIP]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-encoding"), "");
    assert_eq!(r.body, logo);

    // A missing asset is a 404 (not index.html cached for a year).
    let r = get_with(&t, "/assets/index-old.js", &[GZIP]).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.header("cache-control"), "no-store");

    // index.html and client routes: no-cache, gzipped.
    for uri in ["/", "/index.html", "/games/xyz", "/studio"] {
        let r = get_with(&t, uri, &[GZIP]).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}");
        assert_eq!(r.header("cache-control"), "no-cache", "{uri}");
        assert!(is_gzip(&r), "{uri}");
    }
    let r = t.get("/games/xyz", None).await;
    assert_eq!(r.text(), index);
    // Small text files are sent as they are.
    let r = get_with(&t, "/robots.txt", &[GZIP]).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-encoding"), "");
    assert_eq!(r.header("cache-control"), "no-cache");

    // Source maps are never served, however they are spelled.
    for uri in [
        "/assets/index-abc123.js.map",
        "/assets/index-abc123.js.MAP",
        "/assets/index-abc123.js.%6dap",
        "/assets/index-abc123.js%2Emap",
        "/stray.map",
        "/nothing.map",
    ] {
        let r = get_with(&t, uri, &[GZIP]).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(r.error_code(), "not_found", "{uri}");
    }
}

// ---------------------------------------------------------------------------
// L5: tombstones vs the cap and the mute
// ---------------------------------------------------------------------------

async fn exec(t: &TestApp, sql: &str) {
    sqlx::query(sql).execute(&t.state.db).await.unwrap();
}

async fn scalar(t: &TestApp, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

/// `n` notifications for `rid` from actor `aid`, `updated_at` = base + i minutes; events
/// retracted when `tombstone`.
async fn seed_notifications(
    t: &TestApp,
    rid: &str,
    aid: &str,
    prefix: &str,
    n: usize,
    base: chrono::DateTime<Utc>,
    tombstone: bool,
) {
    let mut tx = t.state.db.begin().await.unwrap();
    for i in 0..n {
        let at = stamp(base + chrono::Duration::minutes(i as i64));
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, \
             created_at, updated_at) VALUES (?1, 'follow', ?2, NULL, NULL, ?3, ?3) RETURNING id",
        )
        .bind(rid)
        .bind(format!("{prefix}{i}"))
        .bind(&at)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO notification_events (notification_id, actor_id, comment_id, \
             created_at, retracted_at) VALUES (?, ?, NULL, ?, ?)",
        )
        .bind(id)
        .bind(aid)
        .bind(&at)
        .bind(tombstone.then(|| at.clone()))
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn l5_tombstone_only_rows_do_not_count_toward_the_cap() {
    let t = setup().await;
    let (_, rid) = t.register("rita").await;
    let (_, aid) = t.register("andy").await;
    let now = Utc::now();
    let cap = PER_RECIPIENT_CAP as usize;
    // `cap` real (older) notifications, then 50 newer tombstone-only rows.
    seed_notifications(
        &t,
        &rid,
        &aid,
        "live",
        cap,
        now - chrono::Duration::days(5),
        false,
    )
    .await;
    seed_notifications(
        &t,
        &rid,
        &aid,
        "gone",
        50,
        now - chrono::Duration::days(1),
        true,
    )
    .await;
    assert_eq!(prune(&t.state.db, now).await.unwrap(), 0);
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE group_key LIKE 'live%'"
        )
        .await,
        PER_RECIPIENT_CAP
    );
    // Tombstone-only rows stay (they still dedupe a re-toggle) until the age rule.
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE group_key LIKE 'gone%'"
        )
        .await,
        50
    );

    // Two more live rows: exactly the two oldest live rows go, tombstones untouched.
    seed_notifications(
        &t,
        &rid,
        &aid,
        "new",
        2,
        now - chrono::Duration::hours(1),
        false,
    )
    .await;
    assert_eq!(prune(&t.state.db, now).await.unwrap(), 2);
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE group_key IN ('live0', 'live1')"
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE group_key LIKE 'gone%'"
        )
        .await,
        50
    );
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notifications").await,
        PER_RECIPIENT_CAP + 50
    );
}

async fn heart_items(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "heart")
        .cloned()
        .collect()
}

async fn toggle(t: &TestApp, method: Method, tok: &str, cid: &str) {
    let r = t
        .send(
            method,
            &format!("/api/comments/{cid}/heart"),
            Some(tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn settings(t: &TestApp, tok: &str, body: Value) {
    let r = t
        .json(Method::PUT, "/api/notifications/settings", Some(tok), body)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

#[tokio::test]
async fn l5_reheart_respects_the_mute() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let (noah, _) = t.register("noah").await;
    let gid = t.create_game(&owner, "G", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&mia),
            json!({ "body": "tip" }),
        )
        .await;
    let cid = r.json()["id"].as_str().unwrap().to_string();

    toggle(&t, Method::PUT, &noah, &cid).await;
    assert_eq!(heart_items(&t, &mia).await.len(), 1);
    toggle(&t, Method::DELETE, &noah, &cid).await;
    assert!(heart_items(&t, &mia).await.is_empty());

    // Muted in between: the re-heart neither restores nor writes anything.
    settings(&t, &mia, json!({ "hearts": false })).await;
    toggle(&t, Method::PUT, &noah, &cid).await;
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notification_events WHERE retracted_at IS NULL \
             AND notification_id IN (SELECT id FROM notifications WHERE kind = 'heart')"
        )
        .await,
        0
    );
    settings(&t, &mia, json!({ "hearts": true })).await;
    assert!(heart_items(&t, &mia).await.is_empty());
    let r = t.get("/api/notifications/unread-count", Some(&mia)).await;
    assert_eq!(r.json()["unread"], 0);

    // Unmuted again: a toggle restores (no new activity), as in review 4 L1.
    toggle(&t, Method::DELETE, &noah, &cid).await;
    toggle(&t, Method::PUT, &noah, &cid).await;
    assert_eq!(heart_items(&t, &mia).await.len(), 1);
}

// ---------------------------------------------------------------------------
// L9: parked fan-outs are retried by housekeeping, whatever the trending TTL
// ---------------------------------------------------------------------------

async fn published_count(t: &TestApp, gid: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications n JOIN notification_events e \
         ON e.notification_id = n.id WHERE n.kind = 'gamePublished' AND n.game_id = ?",
    )
    .bind(gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn l9_housekeeping_unparks_fan_outs_after_backoff() {
    let t = setup_with(|c| c.trending_ttl = Duration::ZERO).await;
    let (owner, _) = t.register("rex").await;
    for name in ["fan_a", "fan_b", "fan_c"] {
        let (tok, _) = t.register(name).await;
        let r = t
            .send(
                Method::PUT,
                "/api/users/rex/follow",
                Some(&tok),
                None,
                vec![],
                &[],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    // Follows must predate the publish (millisecond timestamps).
    tokio::time::sleep(Duration::from_millis(5)).await;
    exec(
        &t,
        "CREATE TRIGGER r5_fail BEFORE INSERT ON notifications \
         WHEN NEW.kind = 'gamePublished' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    .await;
    let gid = t.create_game(&owner, "Lava Leap", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        scalar(&t, "SELECT attempts FROM notification_fanouts").await,
        FAN_OUT_MAX_ATTEMPTS
    );
    exec(&t, "DROP TRIGGER r5_fail").await;

    let t0 = Instant::now();
    let mut hk = Housekeeping::new(t0);
    // Before the backoff: the kick skips the parked row.
    hk.tick(&t.state, t0 + Duration::from_secs(60)).await;
    t.state.fan_out.idle().await;
    assert_eq!(published_count(&t, &gid).await, 0);
    assert_eq!(
        scalar(&t, "SELECT attempts FROM notification_fanouts").await,
        FAN_OUT_MAX_ATTEMPTS
    );
    // After it: un-parked and finished, with no restart.
    hk.tick(&t.state, t0 + FAN_OUT_UNPARK_EVERY).await;
    t.state.fan_out.idle().await;
    assert_eq!(published_count(&t, &gid).await, 3);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_fanouts").await,
        0
    );
    // Later ticks are no-ops.
    hk.tick(&t.state, t0 + FAN_OUT_UNPARK_EVERY * 2 + OPTIMIZE_EVERY)
        .await;
    t.state.fan_out.idle().await;
    assert_eq!(published_count(&t, &gid).await, 3);
}

#[tokio::test]
async fn l9_housekeeping_prunes_with_trending_ttl_zero() {
    let t = setup_with(|c| c.trending_ttl = Duration::ZERO).await;
    let (_, rid) = t.register("rita").await;
    let (_, aid) = t.register("andy").await;
    let old = Utc::now() - chrono::Duration::days(120);
    seed_notifications(&t, &rid, &aid, "old", 3, old, false).await;
    seed_notifications(&t, &rid, &aid, "new", 2, Utc::now(), false).await;

    let maintenance = webgame_server::trending::spawn_maintenance(&t.state);
    assert!(maintenance.trending.is_none());
    assert!(!maintenance.housekeeping.is_finished());
    maintenance.abort();

    // The housekeeping pass itself (driven directly; the task ticks every 60 s).
    let t0 = Instant::now();
    let mut hk = Housekeeping::new(t0);
    hk.tick(&t.state, t0 + Duration::from_secs(60)).await;
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 2);
    // Pruning runs at most once per PRUNE_EVERY.
    seed_notifications(&t, &rid, &aid, "old2", 1, old, false).await;
    hk.tick(&t.state, t0 + Duration::from_secs(120)).await;
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 3);
    hk.tick(
        &t.state,
        t0 + webgame_server::trending::PRUNE_EVERY + Duration::from_secs(60),
    )
    .await;
    assert_eq!(scalar(&t, "SELECT COUNT(*) FROM notifications").await, 2);
}
