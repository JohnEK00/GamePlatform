//! Review round 4 (docs/reviews/REVIEW-2026-11-15-4.md): F007 write-path concurrency (M1),
//! toggle tombstones (L1), the background resumable `gamePublished` fan-out (L2), lock-friendly
//! pruning and the last-event trigger (L3), and the 0014 migration. M2 (screenshot quota) is
//! covered in `tests/f005.rs`.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::*;
use serde_json::Value;
use webgame_server::notifications::{
    self, FAN_OUT_MAX_ATTEMPTS, Kind, NewNotification, drain_fan_outs, prune, resume_fan_outs,
    stamp,
};

async fn tick() {
    tokio::time::sleep(Duration::from_millis(5)).await;
}

async fn scalar(t: &TestApp, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn exec(t: &TestApp, sql: &str) {
    sqlx::query(sql).execute(&t.state.db).await.unwrap();
}

async fn send_empty(t: &TestApp, method: Method, uri: &str, tok: &str) {
    let r = t.send(method, uri, Some(tok), None, vec![], &[]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

async fn items(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

async fn unread(t: &TestApp, tok: &str) -> Value {
    let r = t.get("/api/notifications/unread-count", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn heart_items(t: &TestApp, tok: &str) -> Vec<Value> {
    items(t, tok)
        .await
        .into_iter()
        .filter(|n| n["kind"] == "heart")
        .collect()
}

fn usernames(actors: &Value) -> Vec<String> {
    actors
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["username"].as_str().unwrap().to_string())
        .collect()
}

/// `n` users `{prefix}0000…` following `followee`, inserted directly.
async fn followers(t: &TestApp, prefix: &str, n: usize, followee: &str, at: &str) {
    let mut tx = t.state.db.begin().await.unwrap();
    for i in 0..n {
        let uid = format!("{prefix}{i:04}");
        sqlx::query(
            "INSERT INTO users (id, username, username_lower, email, email_lower, \
             password_hash, display_name, created_at) VALUES (?1, ?1, ?1, ?2, ?2, 'h', ?1, ?3)",
        )
        .bind(&uid)
        .bind(format!("{uid}@x"))
        .bind(at)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)")
            .bind(&uid)
            .bind(followee)
            .bind(at)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

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

// ---------------------------------------------------------------------------
// M1: concurrent writers
// ---------------------------------------------------------------------------

/// Another connection holds the write lock (and then commits) while a deduped notification
/// is written on a second pooled connection. Before the fix the dedupe SELECT opened a read
/// snapshot that went stale at that commit, and the INSERT failed at once with SQLITE_BUSY.
#[tokio::test]
async fn m1_notify_survives_a_concurrent_commit() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (_, mia_id) = t.register("mia").await;

    let mut writer = t.state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE users SET display_name = 'Mia M' WHERE id = ?")
        .bind(&mia_id)
        .execute(&mut *writer)
        .await
        .unwrap();

    let db = t.state.db.clone();
    let n = NewNotification {
        recipient_id: owner_id.clone(),
        kind: Kind::Follow,
        group_key: notifications::FOLLOW_GROUP.to_string(),
        game_id: None,
        comment_id: None,
        actor_id: mia_id.clone(),
        event_comment_id: None,
        dedupe: notifications::Dedupe::Actor,
        thread_id: None,
        collection_id: None,
        now: Utc::now(),
    };
    let task = tokio::spawn(async move {
        let mut conn = db.acquire().await.unwrap();
        notifications::notify(&mut conn, &n).await;
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !task.is_finished(),
        "the notify waits for the write lock instead of failing"
    );
    writer.commit().await.unwrap();
    task.await.unwrap();

    let l = items(&t, &owner).await;
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["kind"], "follow");
    assert_eq!(usernames(&l[0]["actors"]), vec!["mia"]);
}

/// The fan-out started while another connection holds the write lock loses no recipient.
#[tokio::test]
async fn m1_fan_out_survives_a_concurrent_commit() {
    let t = setup().await;
    let (owner, owner_id) = t.register("rex").await;
    followers(&t, "f", 40, &owner_id, &stamp(Utc::now())).await;
    let g = t.create_game(&owner, "Draft", "", false).await;
    let gid = g["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO notification_fanouts (game_id, owner_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(&gid)
    .bind(&owner_id)
    .bind(stamp(Utc::now()))
    .execute(&t.state.db)
    .await
    .unwrap();

    let mut writer = t.state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE games SET published = 1 WHERE id = ?")
        .bind(&gid)
        .execute(&mut *writer)
        .await
        .unwrap();
    t.state.fan_out.kick(&t.state.db);
    tokio::time::sleep(Duration::from_millis(150)).await;
    writer.commit().await.unwrap();
    t.state.fan_out.idle().await;

    assert_eq!(published_count(&t, &gid).await, 40);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_fanouts").await,
        0
    );
}

// ---------------------------------------------------------------------------
// L1: toggling never re-notifies
// ---------------------------------------------------------------------------

#[tokio::test]
async fn l1_heart_toggle_restores_without_bumping() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (ava, _) = t.register("ava").await;
    let (ben, _) = t.register("ben").await;
    let (cara, _) = t.register("cara").await;
    let g = t.create_game(&owner, "Pixel Peaks", "", true).await;
    let gid = g["id"].as_str().unwrap();
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&ava),
            serde_json::json!({ "body": "tip" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let cid = r.json()["id"].as_str().unwrap().to_string();
    let heart_uri = format!("/api/comments/{cid}/heart");

    send_empty(&t, Method::PUT, &heart_uri, &ben).await;
    let first = heart_items(&t, &ava).await;
    assert_eq!(first.len(), 1);
    let at = first[0]["updatedAt"].clone();
    assert_eq!(unread(&t, &ava).await["latestAt"], at);

    for _ in 0..5 {
        tick().await;
        send_empty(&t, Method::DELETE, &heart_uri, &ben).await;
        assert!(heart_items(&t, &ava).await.is_empty());
        assert_eq!(
            scalar(
                &t,
                "SELECT COUNT(*) FROM notification_events WHERE retracted_at IS NOT NULL"
            )
            .await,
            1,
            "tombstoned, not deleted"
        );
        tick().await;
        send_empty(&t, Method::PUT, &heart_uri, &ben).await;
        let l = heart_items(&t, &ava).await;
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["id"], first[0]["id"]);
        assert_eq!(l[0]["updatedAt"], at, "re-heart doesn't bump updatedAt");
        assert_eq!(l[0]["actorCount"], 1);
        assert_eq!(unread(&t, &ava).await["latestAt"], at);
    }

    // A different actor is new activity: bumped, and the retracted actor isn't listed.
    send_empty(&t, Method::DELETE, &heart_uri, &ben).await;
    tick().await;
    send_empty(&t, Method::PUT, &heart_uri, &cara).await;
    let l = heart_items(&t, &ava).await;
    assert_eq!(l.len(), 1);
    assert!(l[0]["updatedAt"].as_str().unwrap() > at.as_str().unwrap());
    assert_eq!(usernames(&l[0]["actors"]), vec!["cara"]);
    assert_eq!(l[0]["actorCount"], 1);
    assert_eq!(l[0]["eventCount"], 1);
    let bumped = l[0]["updatedAt"].clone();
    // ben re-joins: listed again, no bump.
    tick().await;
    send_empty(&t, Method::PUT, &heart_uri, &ben).await;
    let l = heart_items(&t, &ava).await;
    assert_eq!(l[0]["updatedAt"], bumped);
    assert_eq!(l[0]["actorCount"], 2);
}

#[tokio::test]
async fn l1_follow_toggle_restores_without_bumping() {
    let t = setup().await;
    let (owner, _) = t.register("owen").await;
    let (mia, _) = t.register("mia").await;
    let uri = "/api/users/owen/follow";
    send_empty(&t, Method::PUT, uri, &mia).await;
    let first = items(&t, &owner).await;
    assert_eq!(first.len(), 1);
    let at = first[0]["updatedAt"].clone();
    for _ in 0..5 {
        tick().await;
        send_empty(&t, Method::DELETE, uri, &mia).await;
        assert!(items(&t, &owner).await.is_empty());
        assert_eq!(unread(&t, &owner).await["unread"], 0);
        tick().await;
        send_empty(&t, Method::PUT, uri, &mia).await;
        let l = items(&t, &owner).await;
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["updatedAt"], at);
        assert_eq!(unread(&t, &owner).await["latestAt"], at);
    }
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_events").await,
        1
    );
}

// ---------------------------------------------------------------------------
// L2: background, resumable fan-out
// ---------------------------------------------------------------------------

/// A fan-out interrupted after some chunks resumes from its cursor: no duplicates, no gaps,
/// and follows made after the publish are not notified.
#[tokio::test]
async fn l2_fan_out_resumes_from_its_cursor() {
    let t = setup().await;
    let (owner, owner_id) = t.register("rex").await;
    let published_at = stamp(Utc::now() - chrono::Duration::minutes(1));
    let before = stamp(Utc::now() - chrono::Duration::minutes(2));
    followers(&t, "f", 600, &owner_id, &before).await;
    followers(&t, "late", 3, &owner_id, &stamp(Utc::now())).await;
    let g = t.create_game(&owner, "Lava Leap", "", false).await;
    let gid = g["id"].as_str().unwrap().to_string();
    // As if the first chunk (f0000..f0099) had committed before a restart.
    sqlx::query(
        "INSERT INTO notification_fanouts (game_id, owner_id, after_follower, created_at) \
         VALUES (?, ?, 'f0099', ?)",
    )
    .bind(&gid)
    .bind(&owner_id)
    .bind(&published_at)
    .execute(&t.state.db)
    .await
    .unwrap();

    assert_eq!(drain_fan_outs(&t.state.db).await, 2);
    assert_eq!(published_count(&t, &gid).await, 500);
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE kind = 'gamePublished' \
             AND (recipient_id <= 'f0099' OR recipient_id LIKE 'late%')"
        )
        .await,
        0
    );
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_fanouts").await,
        0
    );
    // Draining again is a no-op.
    assert_eq!(drain_fan_outs(&t.state.db).await, 0);
    assert_eq!(published_count(&t, &gid).await, 500);
}

/// The publish response doesn't depend on the fan-out: a failing chunk is retried, then
/// parked; a restart (`resume_fan_outs`) finishes it.
#[tokio::test]
async fn l2_failed_fan_out_is_parked_then_resumed() {
    let t = setup().await;
    let (owner, owner_id) = t.register("rex").await;
    followers(&t, "f", 3, &owner_id, &stamp(Utc::now())).await;
    tick().await;
    exec(
        &t,
        "CREATE TRIGGER r4_fail BEFORE INSERT ON notifications \
         BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    .await;
    let g = t.create_game(&owner, "Lava Leap", "", true).await;
    let gid = g["id"].as_str().unwrap().to_string();
    assert_eq!(published_count(&t, &gid).await, 0);
    assert_eq!(
        scalar(&t, "SELECT attempts FROM notification_fanouts").await,
        FAN_OUT_MAX_ATTEMPTS
    );
    exec(&t, "DROP TRIGGER r4_fail").await;
    // Parked: a plain drain skips it.
    assert_eq!(drain_fan_outs(&t.state.db).await, 0);
    resume_fan_outs(&t.state.db, &t.state.fan_out).await;
    t.state.fan_out.idle().await;
    assert_eq!(published_count(&t, &gid).await, 3);
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_fanouts").await,
        0
    );
}

/// Deleting the game drops its queued fan-out.
#[tokio::test]
async fn l2_game_delete_drops_queued_fan_out() {
    let t = setup().await;
    let (owner, owner_id) = t.register("rex").await;
    let g = t.create_game(&owner, "Lava Leap", "", false).await;
    let gid = g["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO notification_fanouts (game_id, owner_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(&gid)
    .bind(&owner_id)
    .bind(stamp(Utc::now()))
    .execute(&t.state.db)
    .await
    .unwrap();
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{gid}"),
            Some(&owner),
            None,
            vec![],
            &[],
        )
        .await;
    assert!(r.status.is_success(), "{}", r.text());
    assert_eq!(
        scalar(&t, "SELECT COUNT(*) FROM notification_fanouts").await,
        0
    );
}

// ---------------------------------------------------------------------------
// L3: pruning and the last-event trigger
// ---------------------------------------------------------------------------

#[tokio::test]
async fn l3_last_event_gone_removes_the_notification() {
    let t = setup().await;
    let (owner, owner_id) = t.register("owen").await;
    let (mia, mia_id) = t.register("mia").await;
    let (noah, noah_id) = t.register("noah").await;
    send_empty(&t, Method::PUT, "/api/users/owen/follow", &mia).await;
    send_empty(&t, Method::PUT, "/api/users/owen/follow", &noah).await;
    assert_eq!(items(&t, &owner).await[0]["actorCount"], 2);
    // One actor's events cascade away: the notification stays.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&mia_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(items(&t, &owner).await[0]["actorCount"], 1);
    // The last one: the notification goes too.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&noah_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE recipient_id = ?")
        .bind(&owner_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

/// The 200 cap is applied per recipient, in batches, keeping each recipient's newest rows.
#[tokio::test]
async fn l3_per_recipient_cap_in_batches() {
    let t = setup().await;
    let (_, a) = t.register("anna").await;
    let (_, b) = t.register("bert").await;
    let (_, c) = t.register("cleo").await;
    let (_, actor) = t.register("ava").await;
    for (who, n) in [(&a, 1300), (&b, 201), (&c, 200)] {
        sqlx::query(
            "WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?2) \
             INSERT INTO notifications (recipient_id, kind, group_key, created_at, updated_at) \
             SELECT ?1, 'follow', 'k' || i, \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || i || ' minutes'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || i || ' minutes') FROM s",
        )
        .bind(who)
        .bind(n)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO notification_events (notification_id, actor_id, created_at) \
         SELECT id, ?, updated_at FROM notifications",
    )
    .bind(&actor)
    .execute(&t.state.db)
    .await
    .unwrap();

    assert_eq!(prune(&t.state.db, Utc::now()).await.unwrap(), 1100 + 1);
    for who in [&a, &b, &c] {
        let (count, oldest_kept): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), MAX(CAST(substr(group_key, 2) AS INTEGER)) FROM notifications \
             WHERE recipient_id = ?",
        )
        .bind(who)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        assert_eq!(count, 200);
        assert_eq!(oldest_kept, 199, "the newest 200 are kept");
    }
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notification_events WHERE notification_id NOT IN \
             (SELECT id FROM notifications)"
        )
        .await,
        0
    );
    assert_eq!(prune(&t.state.db, Utc::now()).await.unwrap(), 0);
}

// ---------------------------------------------------------------------------
// Migration 0013 → 0014
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_0014_drops_event_less_rows() {
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
                .filter(|x| x.version <= 13)
                .cloned()
                .collect(),
        );
        m.run(&db).await.unwrap();
        for sql in [
            "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
             display_name, created_at) VALUES \
             ('u1', 'Owen', 'owen', 'o@x', 'o@x', 'h', 'Owen', '2026-01-01T00:00:00.000Z'), \
             ('u2', 'Mia', 'mia', 'm@x', 'm@x', 'h', 'Mia', '2026-01-01T00:00:00.000Z')",
            "INSERT INTO notifications (id, recipient_id, kind, group_key, created_at, updated_at) \
             VALUES (1, 'u1', 'follow', 'follow', '2026-01-02T00:00:00.000Z', \
             '2026-01-02T00:00:00.000Z'), (2, 'u2', 'follow', 'follow', \
             '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
            "INSERT INTO notification_events (notification_id, actor_id, created_at) \
             VALUES (1, 'u2', '2026-01-02T00:00:00.000Z')",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        db.close().await;
    }
    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM notifications ORDER BY id")
        .fetch_all(&state.db)
        .await
        .unwrap();
    assert_eq!(ids, vec![1]);
    let live: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM notification_events WHERE retracted_at IS NULL")
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(live, 1);
    let fk = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&state.db)
        .await
        .unwrap();
    assert!(fk.is_empty());
}
