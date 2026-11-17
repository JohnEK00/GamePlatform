//! F018: notification controls (game and thread mutes, the `pinned` kind, `threadId`, the
//! `pins` setting, the shared rate limit) and the 0017 rebuild of `notifications` /
//! `notification_events`.

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn admin_app() -> TestApp {
    setup_with(|c| c.admin_usernames = vec!["boss".into()]).await
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

async fn ok(t: &TestApp, method: Method, uri: &str, tok: &str) -> Value {
    let r = send_empty(t, method, uri, Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
    r.json()
}

async fn heart(t: &TestApp, tok: &str, cid: &str) {
    ok(t, Method::PUT, &format!("/api/comments/{cid}/heart"), tok).await;
}

async fn pin(t: &TestApp, tok: &str, cid: &str) -> Value {
    ok(t, Method::PUT, &format!("/api/comments/{cid}/pin"), tok).await
}

async fn unpin(t: &TestApp, tok: &str, cid: &str) -> Value {
    ok(t, Method::DELETE, &format!("/api/comments/{cid}/pin"), tok).await
}

fn game_mute_uri(gid: &str) -> String {
    format!("/api/notifications/mutes/games/{gid}")
}

fn thread_mute_uri(cid: &str) -> String {
    format!("/api/notifications/mutes/threads/{cid}")
}

async fn mute_game(t: &TestApp, tok: &str, gid: &str) -> Value {
    ok(t, Method::PUT, &game_mute_uri(gid), tok).await
}

async fn mute_thread(t: &TestApp, tok: &str, cid: &str) -> Value {
    ok(t, Method::PUT, &thread_mute_uri(cid), tok).await
}

async fn mutes(t: &TestApp, tok: &str) -> Value {
    let r = t.get("/api/notifications/mutes", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn items(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/notifications?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

fn of_kind(items: &[Value], kind: &str) -> Vec<Value> {
    items
        .iter()
        .filter(|n| n["kind"] == kind)
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

/// Notification rows of any state (read, unread, withdrawn) for the recipient.
async fn stored(t: &TestApp, uid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM notifications WHERE recipient_id = ?",
        uid,
    )
    .await
}

async fn mute_rows(t: &TestApp, uid: &str) -> i64 {
    scalar(
        t,
        "SELECT COUNT(*) FROM notification_mutes WHERE user_id = ?",
        uid,
    )
    .await
}

/// Top-level comments of the game (page 1) as seen by `tok`, plus the pinned one.
async fn threads(t: &TestApp, tok: Option<&str>, gid: &str) -> Vec<Value> {
    let r = t.get(&format!("/api/games/{gid}/comments"), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    let mut out: Vec<Value> = v["items"].as_array().unwrap().clone();
    if !v["pinned"].is_null() {
        out.push(v["pinned"].clone());
    }
    out
}

fn thread_of<'a>(threads: &'a [Value], cid: &str) -> &'a Value {
    threads
        .iter()
        .find(|th| th["id"] == cid)
        .unwrap_or_else(|| panic!("thread {cid} not listed"))
}

// ---------------------------------------------------------------------------
// Upgrade (spec § 6, required)
// ---------------------------------------------------------------------------

type NotifRow = (
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);
type EventRow = (i64, i64, String, Option<String>, String, Option<String>);

const NOTIF_ROWS: &str = "SELECT id, recipient_id, kind, group_key, game_id, comment_id, \
     read_at, created_at, updated_at FROM notifications ORDER BY id";
const EVENT_ROWS: &str = "SELECT id, notification_id, actor_id, comment_id, created_at, \
     retracted_at FROM notification_events ORDER BY id";
/// Later migrations may add their own indexes (0019: `idx_notifications_collection`); this
/// test checks that the 0017 rebuild keeps the existing ones.
const SCHEMA_OF: &str = "SELECT type, name, tbl_name, sql FROM sqlite_master \
     WHERE tbl_name IN ('notifications', 'notification_events') AND type IN ('index', 'trigger') \
     AND sql IS NOT NULL AND name <> 'idx_notifications_collection' ORDER BY type, name";

/// `sqlite_master` entries whose name or SQL contains `_new`.
const WITH_NEW: &str = "SELECT name FROM sqlite_master WHERE instr(name, '_new') > 0 \
     OR instr(IFNULL(sql, ''), '_new') > 0 ORDER BY name";

/// The 0004 indexes legitimately contain `_new` ("newest"); nothing else may, before or after.
fn expected_with_new() -> Vec<String> {
    [
        "idx_games_owner_new",
        "idx_games_owner_pub_new",
        "idx_games_pub_new",
    ]
    .map(String::from)
    .to_vec()
}

#[tokio::test]
async fn migration_upgrade_from_0016() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let dir = common::test_dir();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        data.join("webgame.db").to_string_lossy().replace('\\', "/")
    );
    type Schema = Vec<(String, String, String, String)>;
    type Fanout = (String, String, String, i64, String);
    let fanout_sql =
        "SELECT game_id, owner_id, after_follower, attempts, created_at FROM notification_fanouts";
    let (notifs_before, events_before, schema_before, fanout_before): (
        Vec<NotifRow>,
        Vec<EventRow>,
        Schema,
        Fanout,
    ) = {
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
                .filter(|x| x.version <= 16)
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
                 updated_at, actions_json, controls_hint) VALUES \
                 ('g1', 'u1', 'Old', 'main.js', 800, 600, '{ts}', '{ts}', '[]', '')"
            ),
            format!(
                "INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id) VALUES \
                 ('c1', 'g1', 'u1', 'root comment', '{ts}', NULL), \
                 ('c2', 'g1', 'u2', 'first reply', '2026-01-01T00:01:00.000Z', 'c1'), \
                 ('c3', 'g1', 'u2', 'second reply', '2026-01-01T00:02:00.000Z', 'c1')"
            ),
            // 5: unread heart, one live and one retracted event; 9: read reply group with
            // two events; 12: unread follow; 20: deleted below (sequence high-water mark).
            "INSERT INTO notifications (id, recipient_id, kind, group_key, game_id, comment_id, \
             read_at, created_at, updated_at) VALUES \
             (5, 'u1', 'heart', 'comment:c1', 'g1', 'c1', NULL, '2026-01-02T00:00:00.000Z', \
              '2026-01-02T00:05:00.000Z'), \
             (9, 'u1', 'reply', 'thread:c1', 'g1', 'c1', '2026-01-03T09:00:00.000Z', \
              '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z'), \
             (12, 'u1', 'follow', 'follow', NULL, NULL, NULL, '2026-01-04T00:00:00.000Z', \
              '2026-01-04T00:00:00.000Z'), \
             (20, 'u2', 'heart', 'comment:c2', 'g1', 'c2', NULL, '2026-01-05T00:00:00.000Z', \
              '2026-01-05T00:00:00.000Z')"
                .to_string(),
            "INSERT INTO notification_events (id, notification_id, actor_id, comment_id, \
             created_at, retracted_at) VALUES \
             (1, 5, 'u2', NULL, '2026-01-02T00:00:00.000Z', NULL), \
             (2, 5, 'u3', NULL, '2026-01-02T00:05:00.000Z', '2026-01-02T01:00:00.000Z'), \
             (3, 9, 'u2', 'c2', '2026-01-01T00:01:00.000Z', NULL), \
             (4, 9, 'u3', 'c3', '2026-01-01T00:02:00.000Z', NULL), \
             (6, 12, 'u3', NULL, '2026-01-04T00:00:00.000Z', NULL), \
             (30, 20, 'u1', NULL, '2026-01-05T00:00:00.000Z', NULL)"
                .to_string(),
            // The 0014 trigger removes notification 20 with its only event.
            "DELETE FROM notification_events WHERE id = 30".to_string(),
            "INSERT INTO notification_settings (user_id, comments, replies, hearts, follows, \
             new_games, updated_at) VALUES ('u1', 1, 0, 1, 0, 1, '2026-01-06T00:00:00.000Z')"
                .to_string(),
            "INSERT INTO notification_fanouts (game_id, owner_id, after_follower, attempts, \
             created_at) VALUES ('g1', 'u1', 'u2', 2, '2026-01-07T00:00:00.000Z')"
                .to_string(),
        ] {
            sqlx::query(&sql).execute(&db).await.unwrap();
        }
        let notifs: Vec<NotifRow> = sqlx::query_as(NOTIF_ROWS).fetch_all(&db).await.unwrap();
        let events: Vec<EventRow> = sqlx::query_as(EVENT_ROWS).fetch_all(&db).await.unwrap();
        assert_eq!(
            notifs.iter().map(|n| n.0).collect::<Vec<_>>(),
            vec![5, 9, 12],
            "the 0014 trigger removed notification 20"
        );
        assert_eq!(events.len(), 5);
        let seq: Vec<(String, i64)> = sqlx::query_as(
            "SELECT name, seq FROM sqlite_sequence \
             WHERE name IN ('notifications', 'notification_events') ORDER BY name",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(
            seq,
            vec![
                ("notification_events".to_string(), 30),
                ("notifications".to_string(), 20)
            ]
        );
        let schema: Schema = sqlx::query_as(SCHEMA_OF).fetch_all(&db).await.unwrap();
        assert_eq!(
            schema.len(),
            11,
            "10 indexes and the 0014 trigger: {schema:?}"
        );
        let fanout: Fanout = sqlx::query_as(fanout_sql).fetch_one(&db).await.unwrap();
        // Baseline: the only `_new` names before 0017 are the 0004 "newest games" indexes.
        let with_new: Vec<String> = sqlx::query_scalar(WITH_NEW).fetch_all(&db).await.unwrap();
        assert_eq!(with_new, expected_with_new());
        db.close().await;
        (notifs, events, schema, fanout)
    };

    // Run every migration (0017 included) the way the server does at startup.
    let mut config = webgame_server::Config::for_data_dir(&data);
    config.database_url = url;
    let state = webgame_server::AppState::new(config).await.unwrap();
    let db = state.db.clone();

    // 1. Same rows, all columns (ids and retracted_at included).
    let notifs: Vec<NotifRow> = sqlx::query_as(NOTIF_ROWS).fetch_all(&db).await.unwrap();
    let events: Vec<EventRow> = sqlx::query_as(EVENT_ROWS).fetch_all(&db).await.unwrap();
    assert_eq!(notifs, notifs_before);
    assert_eq!(events, events_before);

    // 2. Consistency.
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

    // 3. The child's FK points at the renamed parent; no `_new` leftovers anywhere.
    let fks: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('notification_events') \
         ORDER BY \"from\"",
    )
    .fetch_all(&db)
    .await
    .unwrap();
    assert!(
        fks.contains(&(
            "notifications".into(),
            "notification_id".into(),
            "CASCADE".into()
        )),
        "{fks:?}"
    );
    assert_eq!(fks.len(), 3, "notification, actor, comment: {fks:?}");
    let with_new: Vec<String> = sqlx::query_scalar(WITH_NEW).fetch_all(&db).await.unwrap();
    assert_eq!(with_new, expected_with_new(), "no rebuild leftovers");
    let refs_new: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE instr(IFNULL(sql, ''), 'notifications_new') > 0 \
         OR instr(IFNULL(sql, ''), 'notification_events_new') > 0",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(refs_new, 0);
    let seq_names: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_sequence WHERE instr(name, '_new') > 0")
            .fetch_all(&db)
            .await
            .unwrap();
    assert!(seq_names.is_empty(), "{seq_names:?}");

    // 4. No kind CHECK any more.
    let table_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(!table_sql.contains("CHECK (kind"), "{table_sql}");
    assert!(!table_sql.contains("kind IN ("), "{table_sql}");

    // 5. The ten F007 indexes and the 0014 trigger, with their original definitions.
    let schema: Schema = sqlx::query_as(SCHEMA_OF).fetch_all(&db).await.unwrap();
    assert_eq!(schema, schema_before);
    let mut index_names: Vec<&str> = schema
        .iter()
        .filter(|(ty, ..)| ty == "index")
        .map(|(_, name, ..)| name.as_str())
        .collect();
    index_names.sort_unstable();
    assert_eq!(
        index_names,
        vec![
            "idx_notification_events_actor",
            "idx_notification_events_comment",
            "idx_notification_events_dedupe",
            "idx_notifications_comment",
            "idx_notifications_game",
            "idx_notifications_group",
            "idx_notifications_open_group",
            "idx_notifications_read_at",
            "idx_notifications_recipient_updated",
            "idx_notifications_updated",
        ]
    );
    assert!(schema.iter().any(|(ty, name, tbl, _)| ty == "trigger"
        && name == "notification_events_last_gone"
        && tbl == "notification_events"));

    // 6. Sequences preserved: ids of deleted rows are never reused.
    let pinned_id: i64 = sqlx::query_scalar(
        "INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, \
         created_at, updated_at) VALUES ('u2', 'pinned', 'pin:c2', 'g1', 'c2', \
         '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z') RETURNING id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(pinned_id, 21);
    let event_id: i64 = sqlx::query_scalar(
        "INSERT INTO notification_events (notification_id, actor_id, comment_id, created_at) \
         VALUES (21, 'u1', NULL, '2026-02-01T00:00:00.000Z') RETURNING id",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(event_id, 31);

    // The read path still works on migrated rows (threadId included).
    let (page, _) = webgame_server::notifications::list_page(&db, "u1", false, None, 50)
        .await
        .unwrap();
    let by_id = |id: &str| page.iter().find(|n| n.id == id).unwrap().clone();
    assert_eq!(page.len(), 3);
    assert_eq!(
        by_id("5").actor_count,
        1,
        "the retracted event stays hidden"
    );
    assert_eq!(by_id("5").thread_id.as_deref(), Some("c1"));
    assert_eq!(by_id("9").thread_id.as_deref(), Some("c1"));
    assert_eq!(by_id("9").event_count, 2);
    assert_eq!(by_id("12").thread_id, None);

    // 7. Trigger and cascades work on the rebuilt tables.
    let count = |sql: &'static str| {
        let db = db.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .fetch_one(&db)
                .await
                .unwrap()
        }
    };
    sqlx::query("DELETE FROM notification_events WHERE id = 6")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        count("SELECT COUNT(*) FROM notifications WHERE id = 12").await,
        0,
        "the trigger removed notification 12 with its last event"
    );
    sqlx::query("DELETE FROM notifications WHERE id = 5")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        count("SELECT COUNT(*) FROM notification_events WHERE notification_id = 5").await,
        0,
        "events cascade with their notification"
    );
    sqlx::query("DELETE FROM users WHERE id = 'u3'")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        count("SELECT COUNT(*) FROM notification_events WHERE actor_id = 'u3'").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM notification_events WHERE notification_id = 9").await,
        1,
        "u2's event of notification 9 stays"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM notifications WHERE id = 9").await,
        1
    );

    // 8. Settings gain `pins` (on), mutes start empty, fan-outs are untouched.
    let settings: (i64, i64, i64) = sqlx::query_as(
        "SELECT replies, follows, pins FROM notification_settings WHERE user_id = 'u1'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(settings, (0, 0, 1));
    assert_eq!(count("SELECT COUNT(*) FROM notification_mutes").await, 0);
    let fanout: Fanout = sqlx::query_as(fanout_sql).fetch_one(&db).await.unwrap();
    assert_eq!(fanout, fanout_before);
}

// ---------------------------------------------------------------------------
// Game mutes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn game_mute_suppresses_every_kind_for_that_game_only() {
    let t = admin_app().await;
    let (mia, mia_id) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let (noah, _) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let g1 = game(&t, &mia, "Space Dodge", true).await;
    let g2 = game(&t, &mia, "Pixel Peaks", true).await;

    // Before the mute: a comment, a reply in mia's thread and a heart on g1; a comment on g2.
    comment(&t, &kai, &g1, "nice game", None).await;
    let mine = comment(&t, &mia, &g1, "dev note", None).await;
    comment(&t, &kai, &g1, "a reply", Some(&mine)).await;
    heart(&t, &kai, &mine).await;
    comment(&t, &kai, &g2, "other game", None).await;
    assert_eq!(unread(&t, &mia).await, 4);

    // Not muted yet.
    let g = t.get(&format!("/api/games/{g1}"), Some(&mia)).await.json();
    assert_eq!(g["notificationsMuted"], false);

    let st = mute_game(&t, &mia, &g1).await;
    assert_eq!(st, json!({ "muted": true, "unread": 1 }));
    assert_eq!(
        unread(&t, &mia).await,
        1,
        "MuteState.unread matches unread-count"
    );
    let all = items(&t, &mia).await;
    assert_eq!(all.len(), 4, "muting marks read, it deletes nothing");
    for n in &all {
        let about_g1 = n["game"]["id"] == g1.as_str();
        assert_eq!(n["read"], about_g1, "{n}");
    }

    // notificationsMuted is viewer-specific and detail-only.
    let g = t.get(&format!("/api/games/{g1}"), Some(&mia)).await.json();
    assert_eq!(g["notificationsMuted"], true);
    for tok in [Some(kai.as_str()), None] {
        let g = t.get(&format!("/api/games/{g1}"), tok).await.json();
        assert_eq!(g["notificationsMuted"], false);
    }
    let g = t.get(&format!("/api/games/{g2}"), Some(&mia)).await.json();
    assert_eq!(g["notificationsMuted"], false);
    let list = t.get("/api/games", Some(&mia)).await.json();
    assert!(list["items"][0].get("notificationsMuted").is_none());

    // While muted: a new comment, a reply, a heart and an (admin) pin on g1 notify nothing.
    let before = stored(&t, &mia_id).await;
    comment(&t, &noah, &g1, "muted comment", None).await;
    comment(&t, &noah, &g1, "muted reply", Some(&mine)).await;
    heart(&t, &noah, &mine).await;
    pin(&t, &boss, &mine).await;
    assert_eq!(stored(&t, &mia_id).await, before);
    assert_eq!(unread(&t, &mia).await, 1);

    // The other game still notifies (joining its unread group).
    comment(&t, &noah, &g2, "still heard", None).await;
    assert_eq!(unread(&t, &mia).await, 1);
    let g2_group: Vec<Value> = of_kind(&items(&t, &mia).await, "comment")
        .into_iter()
        .filter(|n| n["game"]["id"] == g2.as_str())
        .collect();
    assert_eq!(g2_group[0]["eventCount"], 2);

    // Re-PUT is idempotent and keeps createdAt.
    let created = mutes(&t, &mia).await["items"][0]["createdAt"].clone();
    let st = mute_game(&t, &mia, &g1).await;
    assert_eq!(st, json!({ "muted": true, "unread": 1 }));
    let list = mutes(&t, &mia).await;
    assert_eq!(list["total"], 1);
    assert_eq!(list["items"][0]["createdAt"], created);

    // Unmute: nothing comes back, and the next event opens a fresh unread group.
    let st = ok(&t, Method::DELETE, &game_mute_uri(&g1), &mia).await;
    assert_eq!(st, json!({ "muted": false, "unread": 1 }));
    let g = t.get(&format!("/api/games/{g1}"), Some(&mia)).await.json();
    assert_eq!(g["notificationsMuted"], false);
    let old_group = all
        .iter()
        .find(|n| n["kind"] == "comment" && n["game"]["id"] == g1.as_str())
        .unwrap()["id"]
        .clone();
    comment(&t, &kai, &g1, "back again", None).await;
    assert_eq!(unread(&t, &mia).await, 2);
    let fresh: Vec<Value> = of_kind(&items(&t, &mia).await, "comment")
        .into_iter()
        .filter(|n| n["game"]["id"] == g1.as_str() && n["read"] == false)
        .collect();
    assert_eq!(fresh.len(), 1);
    assert_ne!(fresh[0]["id"], old_group);
    assert_eq!(fresh[0]["eventCount"], 1);
}

#[tokio::test]
async fn game_mute_blocks_heart_restores_and_follow_is_never_muted() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let g1 = game(&t, &mia, "Space Dodge", true).await;
    let mine = comment(&t, &mia, &g1, "dev note", None).await;
    heart(&t, &kai, &mine).await;
    ok(
        &t,
        Method::DELETE,
        &format!("/api/comments/{mine}/heart"),
        &kai,
    )
    .await;
    assert_eq!(unread(&t, &mia).await, 0, "retracted");
    mute_game(&t, &mia, &g1).await;
    // A re-heart while muted restores nothing (review 5 L5 rule, extended to mutes).
    heart(&t, &kai, &mine).await;
    assert_eq!(unread(&t, &mia).await, 0);
    assert!(items(&t, &mia).await.is_empty());
    // follow is never muted.
    ok(&t, Method::PUT, "/api/users/mia/follow", &kai).await;
    assert_eq!(unread(&t, &mia).await, 1);
}

// ---------------------------------------------------------------------------
// Thread mutes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn thread_mute_scope_and_thread_muted_flag() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let (noah, _) = t.register("noah").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let t1 = comment(&t, &kai, &g, "kai's thread", None).await;
    let r1 = comment(&t, &kai, &g, "kai's own reply", Some(&t1)).await;
    let t3 = comment(&t, &kai, &g, "kai's other thread", None).await;

    // Before: a reply in t1, a heart on t1 and a heart on a reply in t1.
    comment(&t, &noah, &g, "noah replies", Some(&t1)).await;
    heart(&t, &noah, &t1).await;
    heart(&t, &noah, &r1).await;
    // Out of scope: a heart on t3.
    heart(&t, &noah, &t3).await;
    assert_eq!(unread(&t, &kai).await, 4);

    // Reply ids are refused before anything is written.
    let r = send_empty(&t, Method::PUT, &thread_mute_uri(&r1), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        r.json()["error"]["message"],
        "Only whole threads can be muted"
    );

    let st = mute_thread(&t, &kai, &t1).await;
    assert_eq!(st, json!({ "muted": true, "unread": 1 }));
    assert_eq!(unread(&t, &kai).await, 1);
    let left: Vec<Value> = items(&t, &kai)
        .await
        .into_iter()
        .filter(|n| n["read"] == false)
        .collect();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["commentId"], t3.as_str());

    // threadMuted: only for the muter, only on that top-level comment; replies always false.
    let th = threads(&t, Some(&kai), &g).await;
    assert_eq!(thread_of(&th, &t1)["threadMuted"], true);
    assert_eq!(thread_of(&th, &t3)["threadMuted"], false);
    for reply in thread_of(&th, &t1)["replies"].as_array().unwrap() {
        assert_eq!(reply["threadMuted"], false);
    }
    for tok in [Some(noah.as_str()), Some(mia.as_str()), None] {
        let th = threads(&t, tok, &g).await;
        assert_eq!(thread_of(&th, &t1)["threadMuted"], false);
    }
    let ctx = t
        .get(&format!("/api/comments/{r1}"), Some(&kai))
        .await
        .json();
    assert_eq!(ctx["comment"]["threadMuted"], false);
    assert_eq!(ctx["thread"]["threadMuted"], true);
    let replies = t
        .get(&format!("/api/comments/{t1}/replies"), Some(&kai))
        .await
        .json();
    assert!(
        replies["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["threadMuted"] == false)
    );

    // While muted: replies in t1, hearts on t1 and its replies, and a pin of t1 don't notify.
    let before = stored(&t, &kai_id).await;
    comment(&t, &noah, &g, "muted reply", Some(&t1)).await;
    comment(&t, &mia, &g, "muted owner reply", Some(&r1)).await;
    heart(&t, &mia, &t1).await;
    heart(&t, &mia, &r1).await;
    pin(&t, &mia, &t1).await;
    assert_eq!(stored(&t, &kai_id).await, before);
    assert_eq!(unread(&t, &kai).await, 1);

    // Another thread of the same game still notifies.
    comment(&t, &noah, &g, "heard", Some(&t3)).await;
    assert_eq!(unread(&t, &kai).await, 2);

    // A thread mute never mutes the owner's `comment` kind.
    let noah_thread = comment(&t, &noah, &g, "noah's thread", None).await;
    mark_all_read(&t, &mia).await;
    mute_thread(&t, &mia, &noah_thread).await;
    comment(&t, &kai, &g, "new top-level", None).await;
    assert_eq!(unread(&t, &mia).await, 1);
    assert_eq!(of_kind(&items(&t, &mia).await, "comment")[0]["read"], false);

    // Unmute.
    let st = ok(&t, Method::DELETE, &thread_mute_uri(&t1), &kai).await;
    assert_eq!(st["muted"], false);
    let th = threads(&t, Some(&kai), &g).await;
    assert_eq!(thread_of(&th, &t1)["threadMuted"], false);
    comment(&t, &noah, &g, "heard again", Some(&t1)).await;
    assert_eq!(unread(&t, &kai).await, 3);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mute_validation_order_and_idempotence() {
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let hidden = game(&t, &mia, "Secret", false).await;
    let root = comment(&t, &mia, &g, "root", None).await;
    let reply = comment(&t, &kai, &g, "reply", Some(&root)).await;
    let hidden_root = comment(&t, &mia, &hidden, "hidden root", None).await;
    let long = "x".repeat(65);

    // 401 anonymous, on all five.
    for (m, uri) in [
        (Method::GET, "/api/notifications/mutes".to_string()),
        (Method::PUT, game_mute_uri(&g)),
        (Method::DELETE, game_mute_uri(&g)),
        (Method::PUT, thread_mute_uri(&root)),
        (Method::DELETE, thread_mute_uri(&root)),
    ] {
        let r = send_empty(&t, m, &uri, None).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{uri}");
    }

    // Games: unknown, invisible and over-long ids → 404 "Game not found".
    for gid in ["nope", hidden.as_str(), long.as_str()] {
        let r = send_empty(&t, Method::PUT, &game_mute_uri(gid), Some(&kai)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{gid}");
        assert_eq!(r.error_code(), "not_found");
        assert_eq!(r.json()["error"]["message"], "Game not found");
    }
    // The owner sees (and can mute) their unpublished game.
    assert_eq!(mute_game(&t, &mia, &hidden).await["muted"], true);

    // Threads: unknown, invisible game and over-long → 404 "Comment not found"; reply → 422.
    for cid in ["nope", hidden_root.as_str(), long.as_str()] {
        let r = send_empty(&t, Method::PUT, &thread_mute_uri(cid), Some(&kai)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{cid}");
        assert_eq!(r.json()["error"]["message"], "Comment not found");
    }
    let r = send_empty(&t, Method::PUT, &thread_mute_uri(&reply), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.error_code(), "validation");
    assert_eq!(mute_rows(&t, &kai_id).await, 0);

    // DELETE never 404s: never muted, unknown, over-long and deleted targets.
    for uri in [
        game_mute_uri(&g),
        game_mute_uri("nope"),
        game_mute_uri(&long),
        thread_mute_uri(&root),
        thread_mute_uri(&reply),
        thread_mute_uri(&long),
    ] {
        let st = ok(&t, Method::DELETE, &uri, &kai).await;
        assert_eq!(st, json!({ "muted": false, "unread": 0 }), "{uri}");
    }
    mute_thread(&t, &kai, &root).await;
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{root}"),
        Some(&mia),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let st = ok(&t, Method::DELETE, &thread_mute_uri(&root), &kai).await;
    assert_eq!(st["muted"], false);
    // A deleted root reads as unknown.
    let r = send_empty(&t, Method::PUT, &thread_mute_uri(&root), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Bodies are ignored on the writes.
    let r = t
        .send(
            Method::PUT,
            &game_mute_uri(&g),
            Some(&kai),
            Some("application/json"),
            b"{not json".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    // Re-PUT keeps createdAt.
    let created = mutes(&t, &kai).await["items"][0]["createdAt"].clone();
    mute_game(&t, &kai, &g).await;
    assert_eq!(mutes(&t, &kai).await["items"][0]["createdAt"], created);
    assert_eq!(mute_rows(&t, &kai_id).await, 1);
    let _ = mia_id;
}

#[tokio::test]
async fn mute_cap_is_500_and_re_mute_is_not_counted() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let root = comment(&t, &mia, &g, "root", None).await;
    // 500 mutes inserted directly (500 API calls would exceed the rate limit).
    let ts = "2026-01-01T00:00:00.000Z";
    sqlx::query(
        "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, updated_at, \
         actions_json, controls_hint) \
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) \
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

    let cap = "You can mute at most 500 games and threads; unmute some in Settings";
    for uri in [game_mute_uri(&g), thread_mute_uri(&root)] {
        let r = send_empty(&t, Method::PUT, &uri, Some(&kai)).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
        assert_eq!(r.error_code(), "validation");
        assert_eq!(r.json()["error"]["message"], cap);
    }
    // A re-PUT of an existing mute never 422s.
    assert_eq!(mute_game(&t, &kai, "syn7").await["muted"], true);
    assert_eq!(mute_rows(&t, &kai_id).await, 500);
    let list = mutes(&t, &kai).await;
    assert_eq!(list["total"], 500);
    assert_eq!(list["items"].as_array().unwrap().len(), 500);
    // Unmuting one frees a slot.
    ok(&t, Method::DELETE, &game_mute_uri("syn7"), &kai).await;
    assert_eq!(mute_thread(&t, &kai, &root).await["muted"], true);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mute_list_order_shape_and_visibility() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let g1 = game(&t, &mia, "Space Dodge", true).await;
    let g2 = game(&t, &mia, "Pixel Peaks", true).await;
    let g3 = game(&t, &mia, "Fading Game", true).await;
    let body: String = "é".repeat(100);
    let th = comment(&t, &kai, &g2, &body, None).await;

    assert_eq!(mutes(&t, &kai).await, json!({ "items": [], "total": 0 }));
    // Same-millisecond mutes fall back to insertion order (newest first).
    mute_game(&t, &kai, &g1).await;
    mute_thread(&t, &kai, &th).await;
    mute_game(&t, &kai, &g3).await;

    let list = mutes(&t, &kai).await;
    assert_eq!(list["total"], 3);
    let items = list["items"].as_array().unwrap();
    assert_eq!(items[0]["game"]["id"], g3.as_str());
    let thread = &items[1];
    assert_eq!(thread["target"], "thread");
    assert_eq!(thread["game"]["id"], g2.as_str());
    assert_eq!(thread["game"]["title"], "Pixel Peaks");
    assert!(thread["game"].get("thumbnailUrl").is_some());
    assert_eq!(thread["threadId"], th.as_str());
    assert_eq!(thread["excerpt"], "é".repeat(80));
    assert_eq!(thread["path"], format!("/games/{g2}?comment={th}"));
    assert!(thread["createdAt"].as_str().unwrap().ends_with('Z'));
    let game_row = &items[2];
    assert_eq!(game_row["target"], "game");
    assert_eq!(game_row["game"]["id"], g1.as_str());
    assert_eq!(game_row["threadId"], Value::Null);
    assert_eq!(game_row["excerpt"], Value::Null);
    assert_eq!(game_row["path"], format!("/games/{g1}"));

    // An invisible game's mute is kept but not listed; it comes back on re-publish.
    let patch = |published: bool| {
        let t = &t;
        let mia = mia.clone();
        let g3 = g3.clone();
        async move {
            let r = t
                .json(
                    Method::PATCH,
                    &format!("/api/games/{g3}"),
                    Some(&mia),
                    json!({ "published": published }),
                )
                .await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        }
    };
    patch(false).await;
    let list = mutes(&t, &kai).await;
    assert_eq!(list["total"], 2);
    assert_eq!(list["items"][0]["target"], "thread");
    patch(true).await;
    assert_eq!(mutes(&t, &kai).await["total"], 3);
    // The owner lists their own unpublished game's mute.
    mute_game(&t, &mia, &g3).await;
    patch(false).await;
    assert_eq!(mutes(&t, &mia).await["total"], 1);
}

// ---------------------------------------------------------------------------
// Cascades
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mutes_cascade_with_game_thread_root_and_user() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let g1 = game(&t, &mia, "Space Dodge", true).await;
    let g2 = game(&t, &mia, "Pixel Peaks", true).await;
    let root = comment(&t, &mia, &g2, "root", None).await;
    let reply = comment(&t, &mia, &g2, "reply", Some(&root)).await;
    let other = comment(&t, &mia, &g2, "other root", None).await;
    mute_game(&t, &kai, &g1).await;
    mute_thread(&t, &kai, &root).await;
    mute_thread(&t, &kai, &other).await;
    mute_game(&t, &kai, &g2).await;
    assert_eq!(mute_rows(&t, &kai_id).await, 4);

    // Deleting a reply removes nothing.
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{reply}"),
        Some(&mia),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(mute_rows(&t, &kai_id).await, 4);
    // Deleting the thread root removes its mute.
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{root}"),
        Some(&mia),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(mute_rows(&t, &kai_id).await, 3);
    // Deleting a game removes its game mute and the thread mutes in it.
    let r = send_empty(&t, Method::DELETE, &format!("/api/games/{g2}"), Some(&mia)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text());
    assert_eq!(mute_rows(&t, &kai_id).await, 1);
    // Deleting the user removes the rest.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&kai_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(mute_rows(&t, &kai_id).await, 0);
}

// ---------------------------------------------------------------------------
// Pinned notifications
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pin_notifies_once_and_unpin_withdraws_while_unread() {
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let k = comment(&t, &kai, &g, "pin me please", None).await;

    pin(&t, &mia, &k).await;
    let all = items(&t, &kai).await;
    assert_eq!(all.len(), 1);
    let n = &all[0];
    assert_eq!(n["kind"], "pinned");
    assert_eq!(n["actors"][0]["username"], "mia");
    assert_eq!(n["actorCount"], 1);
    assert_eq!(n["eventCount"], 1);
    assert_eq!(n["game"]["id"], g.as_str());
    assert_eq!(n["commentId"], k.as_str());
    assert_eq!(n["threadId"], k.as_str());
    assert_eq!(n["excerpt"], "pin me please");
    assert_eq!(n["ownsThread"], false);
    assert_eq!(n["creatorHeart"], false);
    assert_eq!(n["read"], false);
    assert_eq!(n["path"], format!("/games/{g}?comment={k}"));
    let first_id = n["id"].clone();
    let first_updated = n["updatedAt"].clone();
    assert_eq!(unread(&t, &kai).await, 1);

    // An idempotent re-PUT neither notifies nor bumps.
    pin(&t, &mia, &k).await;
    let all = items(&t, &kai).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["updatedAt"], first_updated);

    // Unpin while unread → withdrawn: not listed, not counted (the row stays).
    unpin(&t, &mia, &k).await;
    assert!(items(&t, &kai).await.is_empty());
    assert_eq!(unread(&t, &kai).await, 0);
    assert_eq!(stored(&t, &kai_id).await, 1);
    // An idempotent unpin changes nothing.
    unpin(&t, &mia, &k).await;

    // Re-pin → restored, same id and original updatedAt (no move, no second notification).
    tokio::time::sleep(Duration::from_millis(5)).await;
    pin(&t, &mia, &k).await;
    let all = items(&t, &kai).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["id"], first_id);
    assert_eq!(all[0]["updatedAt"], first_updated);
    assert_eq!(unread(&t, &kai).await, 1);

    // After the author read it, unpin and re-pin change nothing.
    mark_all_read(&t, &kai).await;
    unpin(&t, &mia, &k).await;
    let all = items(&t, &kai).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["read"], true);
    pin(&t, &mia, &k).await;
    let all = items(&t, &kai).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["read"], true);
    assert_eq!(unread(&t, &kai).await, 0);
    assert_eq!(stored(&t, &kai_id).await, 1);

    // The owner pinning their own comment notifies nobody.
    let own = comment(&t, &mia, &g, "my own", None).await;
    pin(&t, &mia, &own).await;
    let pinned_for_mia: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notifications WHERE recipient_id = ? AND kind = 'pinned'",
    )
    .bind(&mia_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(pinned_for_mia, 0);
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE comment_id = ?",
            &own
        )
        .await,
        0
    );

    // Deleting the comment removes its notification.
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{k}"),
        Some(&kai),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(stored(&t, &kai_id).await, 0);
}

#[tokio::test]
async fn pin_setting_admin_pins_replace_pin_mutes_and_delete() {
    let t = admin_app().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let (noah, noah_id) = t.register("noah").await;
    let (boss, _) = t.register("boss").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let a = comment(&t, &kai, &g, "kai's comment", None).await;
    let b = comment(&t, &noah, &g, "noah's comment", None).await;

    // Admin pin, then the owner's re-pin after an unpin: still one notification.
    pin(&t, &boss, &a).await;
    let n = of_kind(&items(&t, &kai).await, "pinned");
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["actors"][0]["username"], "boss");
    unpin(&t, &mia, &a).await;
    pin(&t, &mia, &a).await;
    let n = of_kind(&items(&t, &kai).await, "pinned");
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["eventCount"], 1);
    assert_eq!(stored(&t, &kai_id).await, 1);

    // Replace-pin: pinning b notifies noah and withdraws kai's unread pin notification.
    let st = pin(&t, &mia, &b).await;
    assert_eq!(st["unpinnedId"], a.as_str());
    assert_eq!(of_kind(&items(&t, &noah).await, "pinned").len(), 1);
    assert!(of_kind(&items(&t, &kai).await, "pinned").is_empty());
    assert_eq!(unread(&t, &kai).await, 0);

    // pins: false → no pinned notification.
    let r = t
        .json(
            Method::PUT,
            "/api/notifications/settings",
            Some(&kai),
            json!({ "pins": false }),
        )
        .await;
    assert_eq!(r.json()["pins"], false);
    let c = comment(&t, &kai, &g, "another one", None).await;
    pin(&t, &mia, &c).await;
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE comment_id = ?",
            &c
        )
        .await,
        0
    );
    // ...and a withdrawn one isn't restored while the kind is off.
    pin(&t, &mia, &a).await;
    assert!(of_kind(&items(&t, &kai).await, "pinned").is_empty());
    t.json(
        Method::PUT,
        "/api/notifications/settings",
        Some(&kai),
        json!({ "pins": true }),
    )
    .await;

    // A game mute and a thread mute suppress it (and restores).
    mute_game(&t, &kai, &g).await;
    let d = comment(&t, &kai, &g, "muted game", None).await;
    pin(&t, &mia, &d).await;
    pin(&t, &mia, &a).await;
    assert!(of_kind(&items(&t, &kai).await, "pinned").is_empty());
    ok(&t, Method::DELETE, &game_mute_uri(&g), &kai).await;
    let e = comment(&t, &kai, &g, "muted thread", None).await;
    mute_thread(&t, &kai, &e).await;
    pin(&t, &mia, &e).await;
    assert_eq!(
        scalar(
            &t,
            "SELECT COUNT(*) FROM notifications WHERE comment_id = ?",
            &e
        )
        .await,
        0
    );

    // Muting the thread marks its unread pin read.
    let f = comment(&t, &noah, &g, "noah again", None).await;
    pin(&t, &mia, &f).await;
    assert_eq!(unread(&t, &noah).await, 1);
    assert_eq!(mute_thread(&t, &noah, &f).await["unread"], 0);

    // Deleting the comment removes its notification.
    assert_eq!(stored(&t, &noah_id).await, 2);
    let r = send_empty(
        &t,
        Method::DELETE,
        &format!("/api/comments/{f}"),
        Some(&noah),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(stored(&t, &noah_id).await, 1);
}

// ---------------------------------------------------------------------------
// threadId
// ---------------------------------------------------------------------------

#[tokio::test]
async fn thread_id_per_kind() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let (noah, _) = t.register("noah").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let k = comment(&t, &kai, &g, "root", None).await;
    let r = comment(&t, &noah, &g, "reply", Some(&k)).await;
    heart(&t, &mia, &r).await;
    heart(&t, &mia, &k).await;
    pin(&t, &mia, &k).await;
    ok(&t, Method::PUT, "/api/users/mia/follow", &kai).await;

    let kai_items = items(&t, &kai).await;
    assert_eq!(of_kind(&kai_items, "reply")[0]["threadId"], k.as_str());
    assert_eq!(of_kind(&kai_items, "heart")[0]["threadId"], k.as_str());
    assert_eq!(of_kind(&kai_items, "pinned")[0]["threadId"], k.as_str());
    let noah_heart = of_kind(&items(&t, &noah).await, "heart");
    assert_eq!(noah_heart[0]["commentId"], r.as_str());
    assert_eq!(
        noah_heart[0]["threadId"],
        k.as_str(),
        "the hearted reply's root"
    );
    let mia_items = items(&t, &mia).await;
    for kind in ["comment", "follow"] {
        let n = of_kind(&mia_items, kind);
        assert_eq!(n.len(), 1, "{kind}");
        assert_eq!(n[0]["threadId"], Value::Null, "{kind}");
        assert!(n[0].get("threadId").is_some(), "always present");
    }
}

// ---------------------------------------------------------------------------
// Fan-out, settings, rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn game_published_fan_out_skips_muters() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (kai, kai_id) = t.register("kai").await;
    let (noah, _) = t.register("noah").await;
    ok(&t, Method::PUT, "/api/users/mia/follow", &kai).await;
    ok(&t, Method::PUT, "/api/users/mia/follow", &noah).await;
    let g = game(&t, &mia, "Space Dodge", false).await;
    // Kai can't see the unpublished game, so the mute is set up directly.
    sqlx::query(
        "INSERT INTO notification_mutes (user_id, game_id, thread_id, created_at) \
         VALUES (?, ?, NULL, '2026-01-01T00:00:00.000Z')",
    )
    .bind(&kai_id)
    .bind(&g)
    .execute(&t.state.db)
    .await
    .unwrap();
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{g}"),
            Some(&mia),
            json!({ "published": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(of_kind(&items(&t, &noah).await, "gamePublished").len(), 1);
    assert!(of_kind(&items(&t, &kai).await, "gamePublished").is_empty());
}

#[tokio::test]
async fn pins_setting_defaults_round_trips_and_validates() {
    let t = setup().await;
    let (ava, _) = t.register("ava").await;
    let r = t.get("/api/notifications/settings", Some(&ava)).await;
    assert_eq!(r.json()["pins"], true);
    let put = |body: Value| {
        let t = &t;
        let ava = ava.clone();
        async move {
            t.json(Method::PUT, "/api/notifications/settings", Some(&ava), body)
                .await
        }
    };
    let r = put(json!({ "pins": false })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["pins"], false);
    assert_eq!(r.json()["hearts"], true);
    let r = t.get("/api/notifications/settings", Some(&ava)).await;
    assert_eq!(r.json()["pins"], false);
    // Other fields keep it.
    let r = put(json!({ "hearts": false })).await;
    assert_eq!(r.json()["pins"], false);
    for bad in [
        json!({ "pins": "no" }),
        json!({ "pins": 0 }),
        json!({ "pins": null }),
    ] {
        let r = put(bad.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(r.error_code(), "validation");
    }
    let r = put(json!({ "pins": true })).await;
    assert_eq!(r.json()["pins"], true);
}

#[tokio::test]
async fn mute_endpoints_share_the_notifications_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (mia, _) = t.register("mia").await;
    let (kai, _) = t.register("kai").await;
    let g = game(&t, &mia, "Space Dodge", true).await;
    let root = comment(&t, &mia, &g, "root", None).await;
    for i in 0..120 {
        let (m, uri) = match i % 6 {
            0 => (Method::GET, "/api/notifications/unread-count".to_string()),
            1 => (Method::GET, "/api/notifications/mutes".to_string()),
            2 => (Method::PUT, game_mute_uri(&g)),
            3 => (Method::DELETE, game_mute_uri(&g)),
            4 => (Method::PUT, thread_mute_uri(&root)),
            _ => (Method::DELETE, thread_mute_uri(&root)),
        };
        let r = send_empty(&t, m, &uri, Some(&kai)).await;
        assert_eq!(r.status, StatusCode::OK, "request {i} {uri}: {}", r.text());
    }
    for (m, uri) in [
        (Method::PUT, game_mute_uri(&g)),
        (Method::GET, "/api/notifications/unread-count".to_string()),
    ] {
        let r = send_empty(&t, m, &uri, Some(&kai)).await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{uri}");
        assert_eq!(r.error_code(), "rate_limited");
        assert!(r.header("retry-after").parse::<u64>().unwrap() >= 1);
    }
    // The limit comes before the lookup (an unknown game is still 429, not 404).
    let r = send_empty(&t, Method::PUT, &game_mute_uri("nope"), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Auth comes first; other users have their own bucket.
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&g), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(mute_game(&t, &mia, &g).await["muted"], true);

    t.clock.advance(Duration::from_secs(60));
    let r = send_empty(&t, Method::PUT, &game_mute_uri(&g), Some(&kai)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}
