//! REVIEW-2026-11-14-2 backend fixes: N1 (feed plan), N2 (score_bests), N3 (trending purge,
//! backoff, background refresh), N5 (image upload limits), N9 (Studio linker), N10 (replace
//! reads `published` in its transaction).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use chrono::{DateTime, Utc};
use common::*;
use serde_json::json;
use sqlx::Row;
use webgame_server::routes::feed::FEED_SQL;
use webgame_server::routes::scores::{Period, period_bounds, window_board};
use webgame_server::trending;

async fn plan(t: &TestApp, sql: &str, binds: &[Option<&str>]) -> Vec<String> {
    let eqp = format!("EXPLAIN QUERY PLAN {sql}");
    let mut q = sqlx::query(&eqp);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_all(&t.state.db)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap())
        .collect()
}

// ---------------------------------------------------------------------------
// N1: feed query plan
// ---------------------------------------------------------------------------

#[tokio::test]
async fn n1_feed_plan_is_index_driven() {
    let t = setup().await;
    // Run the planner with statistics too: the plan must not depend on them.
    webgame_server::db::optimize(&t.state.db, true).await;
    sqlx::query("ANALYZE").execute(&t.state.db).await.unwrap();
    // F021: every kind, so branch (c) is planned too.
    let kinds = r#"["gamePublished","gameUpdated","personalBest","achievementUnlocked","collectionUpdated"]"#;
    for cursor in [None, Some("100")] {
        let p = plan(
            &t,
            FEED_SQL,
            &[Some("viewer"), cursor, Some("21"), Some(kinds)],
        )
        .await;
        let text = p.join("\n");
        for line in &p {
            let l = line.to_ascii_lowercase();
            assert!(
                !(l.starts_with("scan e") || l.contains("scan activity_events")),
                "full scan of activity_events:\n{text}"
            );
            assert!(
                !(l.starts_with("scan g") || l.contains("scan games")),
                "scan of games:\n{text}"
            );
            // F021 branch (c): primary-key probes of collections and collection_games only.
            assert!(
                !(l.starts_with("scan c") || l.contains("scan collection")),
                "scan of collections / collection_games:\n{text}"
            );
        }
        assert!(
            text.contains("sqlite_autoindex_collections_1 (id=?)"),
            "branch (c) probes collections by id:\n{text}"
        );
        assert!(
            !text.contains("idx_games_pub_top"),
            "plan walks published games:\n{text}"
        );
        assert!(
            text.contains("USING INDEX idx_activity_actor_id (actor_id=? AND id<?)"),
            "{text}"
        );
        assert!(
            text.contains("USING INDEX idx_activity_game_kind (game_id=? AND kind=? AND id<?)"),
            "{text}"
        );
        assert!(text.contains("idx_favorites_user_game"), "{text}");
    }
}

#[tokio::test]
async fn n1_feed_merges_branches_without_duplicates() {
    let t = setup().await;
    let (viewer, _) = t.register("viewer").await;
    let (alice, _) = t.register("alice").await;
    let (bob, _) = t.register("bob").await;
    let a = t.create_game(&alice, "A", "", true).await;
    let b = t.create_game(&bob, "B", "", true).await;
    let a_id = a["id"].as_str().unwrap();
    let b_id = b["id"].as_str().unwrap();
    let r = t
        .send(
            Method::PUT,
            "/api/users/alice/follow",
            Some(&viewer),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    for gid in [a_id, b_id] {
        let r = t
            .send(
                Method::PUT,
                &format!("/api/games/{gid}/favorite"),
                Some(&viewer),
                None,
                vec![],
                &[],
            )
            .await;
        assert!(r.status.is_success(), "{}", r.text());
    }
    let feed = t.get("/api/feed?limit=1", Some(&viewer)).await.json();
    assert_eq!(feed["items"].as_array().unwrap().len(), 1);
    // Newest first: bob's game (favorite), then alice's (followed and favorited → once).
    assert_eq!(feed["items"][0]["game"]["id"], b_id);
    assert_eq!(feed["items"][0]["reason"], "favorite");
    let cursor = feed["nextCursor"].as_str().unwrap().to_string();
    let feed = t
        .get(&format!("/api/feed?limit=5&cursor={cursor}"), Some(&viewer))
        .await
        .json();
    let items = feed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{feed}");
    assert_eq!(items[0]["game"]["id"], a_id);
    assert_eq!(items[0]["reason"], "following");
    assert!(feed["nextCursor"].is_null());
}

// ---------------------------------------------------------------------------
// N2: score_bests equals the window-function result
// ---------------------------------------------------------------------------

/// The pre-0008 query (`window_board` before N2), used as the reference.
async fn reference_board(
    t: &TestApp,
    game_id: &str,
    period: Period,
    now: DateTime<Utc>,
) -> (Vec<(String, String, i64, String, i64)>, i64) {
    let asc: String = sqlx::query_scalar("SELECT score_order FROM games WHERE id = ?")
        .bind(game_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let dir = if asc == "asc" { "ASC" } else { "DESC" };
    let bounds = period_bounds(period, now);
    let window = if bounds.is_some() {
        "AND s.created_at >= ?2 AND s.created_at < ?3"
    } else {
        ""
    };
    let sql = format!(
        "WITH w AS ( \
           SELECT s.id, s.user_id, s.score, s.created_at, s.rowid AS rid, \
             ROW_NUMBER() OVER (PARTITION BY s.user_id \
               ORDER BY s.score {dir}, s.created_at ASC, s.rowid ASC) AS rn \
           FROM scores s WHERE s.game_id = ?1 {window} \
         ) \
         SELECT id, user_id, score, created_at, \
           RANK() OVER (ORDER BY score {dir}) AS rnk, COUNT(*) OVER () AS total \
         FROM w WHERE rn = 1 ORDER BY score {dir}, created_at ASC, rid ASC"
    );
    let mut q = sqlx::query(&sql).bind(game_id);
    if let Some((s, e)) = &bounds {
        q = q.bind(s).bind(e);
    }
    let rows = q.fetch_all(&t.state.db).await.unwrap();
    let total = rows.first().map(|r| r.get::<i64, _>("total")).unwrap_or(0);
    let list = rows
        .iter()
        .map(|r| {
            (
                r.get("id"),
                r.get("user_id"),
                r.get("score"),
                r.get("created_at"),
                r.get("rnk"),
            )
        })
        .collect();
    (list, total)
}

async fn assert_boards_match(t: &TestApp, game_id: &str, users: &[String], label: &str) {
    let now = Utc::now();
    for period in [Period::Day, Period::Week, Period::All] {
        let (want, want_total) = reference_board(t, game_id, period, now).await;
        let mut conn = t.state.db.acquire().await.unwrap();
        let got = window_board(&mut conn, game_id, period, now, 100, None)
            .await
            .unwrap();
        let got_list: Vec<_> = got
            .entries
            .iter()
            .map(|s| {
                (
                    s.id.clone(),
                    s.user.id.clone(),
                    s.score,
                    s.created_at.clone(),
                    s.rank,
                )
            })
            .collect();
        assert_eq!(got_list, want, "{label} {period:?} entries");
        assert_eq!(got.total_players, want_total, "{label} {period:?} total");
        for uid in users {
            let me = window_board(&mut conn, game_id, period, now, 0, Some(uid))
                .await
                .unwrap()
                .me
                .map(|s| (s.id, s.user.id, s.score, s.created_at, s.rank));
            let want_me = want.iter().find(|w| &w.1 == uid).cloned();
            assert_eq!(me, want_me, "{label} {period:?} me {uid}");
        }
    }
}

#[tokio::test]
async fn n2_score_bests_match_window_functions() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let desc = t.create_game(&owner, "Desc", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let asc = t.create_game(&owner, "Asc", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    sqlx::query("UPDATE games SET score_order = 'asc' WHERE id = ?")
        .bind(&asc)
        .execute(&t.state.db)
        .await
        .unwrap();

    let mut users = Vec::new();
    let mut tokens = Vec::new();
    for i in 0..12 {
        let (tok, id) = t.register(&format!("player{i}")).await;
        users.push(id);
        tokens.push(tok);
    }
    // Deterministic pseudo-random scores: small range (ties), times over the last 3 weeks,
    // some identical timestamps.
    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = |m: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % m
    };
    let now = Utc::now();
    for gid in [&desc, &asc] {
        for _ in 0..300 {
            let u = &users[next(users.len() as u64) as usize];
            let score = next(15) as i64;
            let at = now - chrono::Duration::minutes(next(21 * 24 * 60) as i64);
            let at = if next(5) == 0 {
                now - chrono::Duration::hours(1)
            } else {
                at
            };
            sqlx::query(
                "INSERT INTO scores (id, game_id, user_id, score, created_at) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(gid)
            .bind(u)
            .bind(score)
            .bind(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .execute(&t.state.db)
            .await
            .unwrap();
        }
        // Through the API too (runs pruning, which deletes old non-best rows).
        for tok in tokens.iter().take(6) {
            let r = t
                .json(
                    Method::POST,
                    &format!("/api/games/{gid}/scores"),
                    Some(tok),
                    json!({ "score": next(15) }),
                )
                .await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        }
        assert_boards_match(&t, gid, &users, "after inserts").await;
    }

    // Deleting rows (including stored bests) promotes the next best.
    sqlx::query("DELETE FROM scores WHERE rowid % 3 = 0")
        .execute(&t.state.db)
        .await
        .unwrap();
    for gid in [&desc, &asc] {
        assert_boards_match(&t, gid, &users, "after deletes").await;
    }

    // Flipping the order rebuilds the game's bests.
    sqlx::query("UPDATE games SET score_order = 'desc' WHERE id = ?")
        .bind(&asc)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_boards_match(&t, &asc, &users, "after order change").await;
    // L4: the flip only marked the game stale (served by the fallback above); the deferred
    // rebuild (small batches) then makes the table itself match.
    assert!(
        webgame_server::bests::rebuild_game(&t.state.db, &asc, 5)
            .await
            .unwrap()
    );
    assert_eq!(stale_count(&t, &asc).await, 0);
    assert_boards_match(&t, &asc, &users, "after rebuild").await;

    // Deleting a user removes their bests.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&users[0])
        .execute(&t.state.db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM score_bests WHERE user_id = ?")
        .bind(&users[0])
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    for gid in [&desc, &asc] {
        assert_boards_match(&t, gid, &users[1..], "after user delete").await;
    }

    // Deleting a game removes its bests.
    t.send(
        Method::DELETE,
        &format!("/api/games/{desc}"),
        Some(&owner),
        None,
        vec![],
        &[],
    )
    .await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM score_bests WHERE game_id = ?")
        .bind(&desc)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

async fn stale_count(t: &TestApp, game_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM score_bests_stale WHERE game_id = ?")
        .bind(game_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

async fn bests_rows(t: &TestApp, game_id: &str) -> Vec<(String, String, String, String, i64)> {
    sqlx::query_as(
        "SELECT period, period_start, user_id, score_id, rank_score FROM score_bests \
         WHERE game_id = ? ORDER BY period, period_start, user_id",
    )
    .bind(game_id)
    .fetch_all(&t.state.db)
    .await
    .unwrap()
}

/// L4 (review 3): an order flip no longer rewrites `score_bests` in the flipping transaction;
/// boards stay correct through the fallback, and the batched rebuild restores the table,
/// restarting when another flip lands meanwhile.
#[tokio::test]
async fn l4_order_flip_defers_bests_rebuild() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let gid = t.create_game(&owner, "Flip", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut users = Vec::new();
    for i in 0..9 {
        users.push(t.register(&format!("flipper{i}")).await.1);
    }
    let now = Utc::now();
    for (i, u) in users.iter().enumerate() {
        for k in 0..4i64 {
            let at = now - chrono::Duration::days(k * 3) - chrono::Duration::minutes(i as i64);
            sqlx::query(
                "INSERT INTO scores (id, game_id, user_id, score, created_at) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&gid)
            .bind(u)
            .bind((i as i64 * 7 + k * 5) % 11)
            .bind(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .execute(&t.state.db)
            .await
            .unwrap();
        }
    }
    let before = bests_rows(&t, &gid).await;
    assert!(!before.is_empty());

    // The flip touches no score_bests row; it only marks the game.
    sqlx::query("UPDATE games SET score_order = 'asc' WHERE id = ?")
        .bind(&gid)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(bests_rows(&t, &gid).await, before);
    assert_eq!(stale_count(&t, &gid).await, 1);
    assert_boards_match(&t, &gid, &users, "stale (fallback)").await;

    // Scores submitted while stale are ranked correctly (through the API and the fallback).
    let (tok, uid) = t.register("latecomer").await;
    users.push(uid);
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/scores"),
            Some(&tok),
            json!({ "score": 0 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(r.json()["ranks"]["all"], 1);
    assert_boards_match(&t, &gid, &users, "stale + submit").await;

    // A second flip bumps the generation; a rebuild clears the mark only for the latest one.
    sqlx::query("UPDATE games SET score_order = 'desc' WHERE id = ?")
        .bind(&gid)
        .execute(&t.state.db)
        .await
        .unwrap();
    let generation: i64 =
        sqlx::query_scalar("SELECT generation FROM score_bests_stale WHERE game_id = ?")
            .bind(&gid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(generation, 2);
    assert_boards_match(&t, &gid, &users, "flipped back (fallback)").await;

    // Batches of 2 users → several short transactions.
    assert!(
        webgame_server::bests::rebuild_game(&t.state.db, &gid, 2)
            .await
            .unwrap()
    );
    assert_eq!(stale_count(&t, &gid).await, 0);
    assert_boards_match(&t, &gid, &users, "rebuilt").await;
    // Rebuilding an up-to-date game is a no-op.
    assert_eq!(
        webgame_server::bests::rebuild_stale(&t.state.db, 2)
            .await
            .unwrap(),
        0
    );

    // Corrupted rows are fixed by a rebuild of a stale game (the batches rewrite every user).
    sqlx::query("UPDATE games SET score_order = 'asc' WHERE id = ?")
        .bind(&gid)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE score_bests SET rank_score = 999 WHERE game_id = ?")
        .bind(&gid)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_boards_match(&t, &gid, &users, "corrupt but stale").await;
    assert_eq!(
        webgame_server::bests::rebuild_stale(&t.state.db, 3)
            .await
            .unwrap(),
        1
    );
    assert_boards_match(&t, &gid, &users, "rebuilt after corruption").await;

    // Deleting a stale game drops its mark.
    sqlx::query("UPDATE games SET score_order = 'desc' WHERE id = ?")
        .bind(&gid)
        .execute(&t.state.db)
        .await
        .unwrap();
    t.send(
        Method::DELETE,
        &format!("/api/games/{gid}"),
        Some(&owner),
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(stale_count(&t, &gid).await, 0);
}

/// L4: a bundle replace that changes `leaderboard.order` commits without rebuilding and then
/// rebuilds in the background; boards are correct throughout.
#[tokio::test]
async fn l4_bundle_replace_order_change_rebuilds_in_background() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let gid = t.create_game(&owner, "Replace", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut users = Vec::new();
    for (i, s) in [5, 9, 1].iter().enumerate() {
        let (tok, uid) = t.register(&format!("player{i}")).await;
        users.push(uid);
        let r = t
            .json(
                Method::POST,
                &format!("/api/games/{gid}/scores"),
                Some(&tok),
                json!({ "score": s }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
    }
    let game_json = json!({ "name": "Replace", "entry": "main.js", "width": 800,
        "height": 600, "engine": "1",
        "leaderboard": { "order": "asc", "format": "number", "label": "Moves" } })
    .to_string();
    let bundle = make_zip(&[
        ("game.json", game_json.as_bytes()),
        ("main.js", b"export default { update() {}, render() {} };"),
    ]);
    // Subscribed before the replace, so the run it spawns is always observed.
    let mut runs = t.state.bests_runs.subscribe();
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{gid}/bundle"),
            Some(&owner),
            &[Part::File("bundle", "g.zip", "application/zip", &bundle)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["leaderboard"]["order"], "asc");
    // Correct immediately (fallback or rebuilt, whichever the background task reached).
    let lb = t
        .get(&format!("/api/games/{gid}/leaderboard"), None)
        .await
        .json();
    assert_eq!(lb["entries"][0]["score"], 1);
    assert_eq!(lb["entries"][2]["score"], 9);
    assert_boards_match(&t, &gid, &users, "after replace").await;
    // Await the background run the replace spawned (no polling).
    tokio::time::timeout(Duration::from_secs(30), runs.changed())
        .await
        .expect("background rebuild did not finish")
        .unwrap();
    assert_eq!(stale_count(&t, &gid).await, 0);
    assert_boards_match(&t, &gid, &users, "after background rebuild").await;
}

#[tokio::test]
async fn n2_board_plan_uses_rank_index() {
    let t = setup().await;
    let p = plan(
        &t,
        "SELECT b.score_id FROM score_bests b INDEXED BY idx_score_bests_rank \
         CROSS JOIN users u ON u.id = b.user_id \
         WHERE b.game_id = ?1 AND b.period = ?2 AND b.period_start = ?3 \
         ORDER BY b.rank_score, b.created_at, b.score_rowid LIMIT 10",
        &[Some("g"), Some("all"), Some("")],
    )
    .await
    .join("\n");
    assert!(p.contains("idx_score_bests_rank"), "{p}");
    assert!(!p.contains("TEMP B-TREE"), "{p}");
}

#[tokio::test]
async fn n2_scores_list_is_rate_limited() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owner").await;
    let gid = t.create_game(&owner, "G", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    // 120/min per IP (anonymous), in its own bucket.
    for i in 0..120 {
        let uri = format!("/api/games/{gid}/scores");
        assert_eq!(t.get(&uri, None).await.status, StatusCode::OK, "#{i}");
    }
    let r = t.get(&format!("/api/games/{gid}/scores"), None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert_eq!(r.header("retry-after"), "1");
    // M2: deterministic refill (one token per 0.5 s).
    t.clock.advance(Duration::from_millis(500));
    let uri = format!("/api/games/{gid}/scores");
    assert_eq!(t.get(&uri, None).await.status, StatusCode::OK);
    assert_eq!(
        t.get(&uri, None).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The leaderboard bucket is separate.
    let r = t.get(&format!("/api/games/{gid}/leaderboard"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    // Another viewer (signed in) has its own bucket.
    let r = t
        .get(&format!("/api/games/{gid}/scores"), Some(&owner))
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// N3: purge index, backoff, background refresh
// ---------------------------------------------------------------------------

#[tokio::test]
async fn n3_purge_uses_partial_index_and_keeps_window_keys() {
    let t = setup().await;
    let p = plan(&t, trending::PURGE_SQL, &[Some("2026-01-01")])
        .await
        .join("\n");
    assert!(p.contains("idx_play_events_viewer_key_day"), "{p}");

    let (owner, _) = t.register("owner").await;
    let gid = t.create_game(&owner, "G", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let today = Utc::now().date_naive();
    for (age, key) in [(0, "u:a"), (6, "u:b"), (7, "u:c"), (30, "u:d")] {
        let day = (today - chrono::Duration::days(age))
            .format("%Y-%m-%d")
            .to_string();
        sqlx::query(
            "INSERT INTO play_events (game_id, user_id, day, created_at, viewer_key) \
             VALUES (?, NULL, ?, ?, ?)",
        )
        .bind(&gid)
        .bind(&day)
        .bind(format!("{day}T12:00:00.000Z"))
        .bind(key)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    trending::refresh(&t.state.db, Utc::now()).await.unwrap();
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT viewer_key FROM play_events WHERE viewer_key IS NOT NULL ORDER BY viewer_key",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(keys, ["u:a", "u:b"]);
}

#[tokio::test]
async fn n3_failed_refresh_backs_off() {
    let t = setup_with(|c| {
        c.trending_ttl = Duration::ZERO;
        c.rate_limit = false;
    })
    .await;
    sqlx::query(
        "CREATE TRIGGER fail_trending BEFORE INSERT ON game_trending \
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    .execute(&t.state.db)
    .await
    .unwrap();
    let (o, _) = t.register("owner").await;
    let g = t.create_game(&o, "G", "", true).await;
    let gid = g["id"].as_str().unwrap();
    sqlx::query(
        "INSERT INTO play_events (game_id, user_id, day, created_at, viewer_key) \
         VALUES (?, NULL, ?, ?, 'u:x')",
    )
    .bind(gid)
    .bind(Utc::now().format("%Y-%m-%d").to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&t.state.db)
    .await
    .unwrap();
    let f0 = t.state.trending.failure_count();
    for uri in [
        "/api/games?sort=trending".to_string(),
        format!("/api/games/{gid}/related"),
        "/api/games?sort=trending".to_string(),
    ] {
        assert_eq!(t.get(&uri, None).await.status, StatusCode::OK, "{uri}");
    }
    assert_eq!(
        t.state.trending.failure_count(),
        f0 + 1,
        "one attempt, then backoff"
    );
}

#[tokio::test]
async fn n3_background_task_refreshes_off_the_request_path() {
    // TTL 0: no trending task (review 5 L9: housekeeping still runs).
    let t0 = setup_with(|c| c.trending_ttl = Duration::ZERO).await;
    let m0 = trending::spawn_maintenance(&t0.state);
    assert!(m0.trending.is_none());
    assert!(!m0.housekeeping.is_finished());
    m0.abort();

    let t = setup_with(|c| c.trending_ttl = Duration::from_secs(1)).await;
    assert_eq!(t.state.trending.refresh_count(), 1, "startup refresh");
    let (o, _) = t.register("owner").await;
    let g = t.create_game(&o, "G", "", true).await;
    let gid = g["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO play_events (game_id, user_id, day, created_at, viewer_key) \
         VALUES (?, NULL, ?, ?, 'u:x')",
    )
    .bind(&gid)
    .bind(Utc::now().format("%Y-%m-%d").to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&t.state.db)
    .await
    .unwrap();
    // Requests never refresh when TTL > 0.
    t.get("/api/games?sort=trending", None).await;
    assert_eq!(t.state.trending.refresh_count(), 1);

    let task = trending::spawn_maintenance(&t.state);
    assert!(task.trending.is_some());
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while t.state.trending.refresh_count() < 2 {
        assert!(
            std::time::Instant::now() < deadline,
            "background refresh did not run"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    task.abort();
    let v = t.get("/api/games?sort=trending", None).await.json();
    assert_eq!(v["items"][0]["id"], gid.as_str());
    assert_eq!(v["items"][0]["playsWeek"], 1);
}

// ---------------------------------------------------------------------------
// N5: image upload rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn n5_thumbnail_and_avatar_share_image_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("artist").await;
    let gid = t.create_game(&tok, "Pics", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let png = png_bytes();
    for i in 0..20 {
        let r = if i % 2 == 0 {
            t.multipart(
                Method::PUT,
                &format!("/api/games/{gid}/thumbnail"),
                Some(&tok),
                &[Part::File("thumbnail", "t.png", "image/png", &png)],
            )
            .await
        } else {
            t.multipart(
                Method::PUT,
                "/api/users/me/avatar",
                Some(&tok),
                &[Part::File("avatar", "a.png", "image/png", &png)],
            )
            .await
        };
        assert_eq!(r.status, StatusCode::OK, "#{i}: {}", r.text());
    }
    for (uri, field) in [
        (format!("/api/games/{gid}/thumbnail"), "thumbnail"),
        ("/api/users/me/avatar".to_string(), "avatar"),
    ] {
        let r = t
            .multipart(
                Method::PUT,
                &uri,
                Some(&tok),
                &[Part::File(field, "x.png", "image/png", &png)],
            )
            .await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{uri}");
        assert_eq!(r.error_code(), "rate_limited");
        // 20/hour: one token every 180 s.
        assert_eq!(r.header("retry-after"), "180");
    }
    // M2: after 180 s (manual clock) exactly one more upload is accepted.
    t.clock.advance(Duration::from_secs(180));
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/avatar",
            Some(&tok),
            &[Part::File("avatar", "a.png", "image/png", &png)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/avatar",
            Some(&tok),
            &[Part::File("avatar", "a.png", "image/png", &png)],
        )
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Another user is unaffected.
    let (other, _) = t.register("other").await;
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/avatar",
            Some(&other),
            &[Part::File("avatar", "a.png", "image/png", &png)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// N9: Studio linker ignores comments and strings
// ---------------------------------------------------------------------------

const LINKER_HARNESS: &str = r#"
const {{ resolveObjectURL }} = require("node:buffer");
const urlToFile = new Map();
__LINKER__
const text = (url) => resolveObjectURL(url).text();
(async () => {{
  const files = {{
    "main.js": [
      '// import "./old.js";',
      "/* import { gone } from './gone.js'; */",
      "const s = \"import './nope.js'\";",
      "const tpl = `from './tpl.js' ${ 1 + 1 }`;",
      "const re = /import \"x\"/;",
      'import { x } from "./lib/x.js";',
      "export default { x, s, tpl, re };",
    ].join("\n"),
    "lib/x.js": "export const x = 1; // see import './missing.js'",
  }};
  const url = linkModules(files, "main.js");
  const main = await text(url);
  if (!main.includes('// import "./old.js";')) throw new Error("comment rewritten: " + main);
  if (!main.includes("\"import './nope.js'\"")) throw new Error("string rewritten: " + main);
  if (!/from "blob:/.test(main)) throw new Error("real import not linked: " + main);
  let failed = "";
  try {{
    linkModules({{ "main.js": 'import "./missing.js";' }}, "main.js");
  }} catch (e) {{
    failed = e.message;
  }}
  if (!failed.includes("not found")) throw new Error("missing import not reported: " + failed);
  console.log("LINKER_OK");
}})().catch((e) => {{ console.error(e); process.exit(1); }});
"#;

#[tokio::test]
async fn n9_studio_linker_skips_comments_and_strings() {
    let t = setup().await;
    let html = t.get("/play/studio", None).await.text();
    assert!(html.contains("const codeMask = (src) =>"));
    assert!(html.contains("if (mask[offset] ||"));
    let start = html.find("  const SPEC = ").expect("linker start");
    let end = html.find("  let boot;").expect("linker end");
    // The harness is written with `{{`/`}}` like the Rust template; undo that here.
    let harness = LINKER_HARNESS
        .replace("{{", "{")
        .replace("}}", "}")
        .replace("__LINKER__", &html[start..end]);
    let node = std::process::Command::new("node").arg("--version").output();
    if node.map(|o| !o.status.success()).unwrap_or(true) {
        eprintln!("node not found; skipping the linker execution check");
        return;
    }
    let path = t.dir.path().join("linker_check.cjs");
    std::fs::write(&path, harness).unwrap();
    let out = std::process::Command::new("node")
        .arg(&path)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success() && stdout.contains("LINKER_OK"),
        "stdout: {stdout}\nstderr: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// N10: replace reads `published` inside its transaction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn n10_unpublish_during_replace_is_not_an_update() {
    let t = setup().await;
    let (tok, _) = t.register("racer").await;
    let gid = t.create_game(&tok, "Race", "", true).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Hold the write lock with an unpublish while the replace runs: the request reads the game
    // as published (WAL readers see the last commit) and then waits for the lock.
    let mut tx = t.state.db.begin().await.unwrap();
    sqlx::query("UPDATE games SET published = 0 WHERE id = ?")
        .bind(&gid)
        .execute(&mut *tx)
        .await
        .unwrap();
    let router = t.router.clone();
    let zip = valid_bundle();
    let (ct, body) = multipart_body(&[Part::File("bundle", "g.zip", "application/zip", &zip)]);
    let uri = format!("/api/games/{gid}/bundle");
    let auth = format!("Bearer {tok}");
    let req = tokio::spawn(async move {
        use tower::ServiceExt;
        let req = axum::http::Request::builder()
            .method(Method::PUT)
            .uri(uri)
            .header("authorization", auth)
            .header("content-type", ct)
            .body(axum::body::Body::from(body))
            .unwrap();
        router.oneshot(req).await.unwrap().status()
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    tx.commit().await.unwrap();
    assert_eq!(req.await.unwrap(), StatusCode::OK);

    let (version, last_updated): (i64, Option<String>) =
        sqlx::query_as("SELECT version, last_updated_at FROM games WHERE id = ?")
            .bind(&gid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(version, 2, "the replace itself went through");
    assert!(
        last_updated.is_none(),
        "unpublished at commit: not an update"
    );
    let updates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM activity_events WHERE game_id = ? AND kind = 'gameUpdated'",
    )
    .bind(&gid)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(updates, 0);
}
