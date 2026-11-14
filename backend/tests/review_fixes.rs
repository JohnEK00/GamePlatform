//! Regression tests for docs/reviews/REVIEW-2026-11-14-1.md (R1, R2, R3, R5, R6, R7, R8, R12).

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;
use webgame_server::routes::games::{ListQuery, list_filter, list_order};

fn bundle_with(main_js: &str, filler: usize) -> Vec<u8> {
    let pad = vec![b'x'; filler];
    make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", main_js.as_bytes()),
        ("assets/pad.txt", &pad),
    ])
}

async fn replace(t: &TestApp, tok: &str, id: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(tok),
        &[Part::File("bundle", "game.zip", "application/zip", zip)],
    )
    .await
}

fn dir_names(p: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(p)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------------------
// R1: concurrent bundle replaces
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r1_concurrent_replaces_one_wins_files_intact() {
    let t = setup().await;
    let (tok, _) = t.register("racer").await;
    let g = t.create_game(&tok, "Race", "", true).await;
    let id = g["id"].as_str().unwrap();

    let za = bundle_with("export default { a: 1 };", 4 << 20);
    let zb = bundle_with("export default { b: 2 };", 4 << 20);
    let (ra, rb) = tokio::join!(replace(&t, &tok, id, &za), replace(&t, &tok, id, &zb));
    let mut statuses = [ra.status.as_u16(), rb.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{} / {}", ra.text(), rb.text());
    let (winner, loser) = if ra.status == StatusCode::OK {
        (ra, rb)
    } else {
        (rb, ra)
    };
    assert_eq!(loser.error_code(), "conflict");
    assert_eq!(winner.json()["version"], 2);

    let game = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(game["version"], 2);
    let f = t.get(&format!("/games/{id}/files/main.js"), None).await;
    assert_eq!(f.status, StatusCode::OK);
    let body = f.text();
    assert!(
        body == "export default { a: 1 };" || body == "export default { b: 2 };",
        "{body}"
    );
    // Only the live version remains on disk: no staging dirs, no old version.
    let game_dir = t.state.storage.game_dir(id);
    assert_eq!(dir_names(&game_dir), vec!["v2".to_string()]);

    // The claim is released: a later replace succeeds.
    let r = replace(&t, &tok, id, &valid_bundle()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["version"], 3);
    assert_eq!(dir_names(&game_dir), vec!["v3".to_string()]);
    let f = t.get(&format!("/games/{id}/files/main.js"), None).await;
    assert_eq!(f.status, StatusCode::OK);
}

#[tokio::test]
async fn r1_failed_replace_keeps_live_version() {
    let t = setup().await;
    let (tok, _) = t.register("keeper").await;
    let g = t.create_game(&tok, "Keep", "", true).await;
    let id = g["id"].as_str().unwrap();
    let bad = make_zip(&[("readme.txt", b"no manifest")]);
    let r = replace(&t, &tok, id, &bad).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        dir_names(&t.state.storage.game_dir(id)),
        vec!["v1".to_string()]
    );
    let f = t.get(&format!("/games/{id}/files/main.js"), None).await;
    assert_eq!(f.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// R2: play counting
// ---------------------------------------------------------------------------

async fn play(t: &TestApp, id: &str, tok: Option<&str>) -> Resp {
    t.send(
        Method::POST,
        &format!("/api/games/{id}/play"),
        tok,
        None,
        vec![],
        &[],
    )
    .await
}

#[tokio::test]
async fn r2_plays_deduplicated_per_viewer() {
    let t = setup().await;
    let (tok, _) = t.register("owner").await;
    let (fan, _) = t.register("fan").await;
    let g = t.create_game(&tok, "Counted", "", true).await;
    let id = g["id"].as_str().unwrap();

    for _ in 0..3 {
        let r = play(&t, id, None).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["plays"], 1);
    }
    let r = play(&t, id, Some(&fan)).await;
    assert_eq!(r.json()["plays"], 2);
    let r = play(&t, id, Some(&fan)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["plays"], 2);
    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM play_events WHERE game_id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(events, 2);
    // Unknown game is still 404.
    assert_eq!(play(&t, "nope", None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn r2_play_rate_limited() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (tok, _) = t.register("owner").await;
    let g = t.create_game(&tok, "Limited", "", true).await;
    let id = g["id"].as_str().unwrap();
    for i in 0..30 {
        let r = play(&t, id, None).await;
        assert_eq!(r.status, StatusCode::OK, "call {i}");
    }
    let r = play(&t, id, None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());
    // Another viewer has its own bucket.
    assert_eq!(play(&t, id, Some(&tok)).await.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// R3: studio multi-file modules
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r3_studio_page_links_modules() {
    let t = setup().await;
    let html = t.get("/play/studio", None).await.text();
    for needle in [
        "const linkModules = (files, entry)",
        "new RegExp(SPEC.source, \"g\")",
        "spec.startsWith(\"./\") && !spec.startsWith(\"../\")",
        "Import cycle ",
        "points outside the project",
        "no JavaScript file",
        "urlToFile.set(url, file)",
        "msg.file = file",
        "url = linkModules(sources, entry)",
    ] {
        assert!(html.contains(needle), "missing {needle:?}");
    }
    // The entry is imported via the linker's blob URL, not a raw blob of the entry source.
    assert!(!html.contains("files[entry] ??"));
}

// ---------------------------------------------------------------------------
// R5: startup sweep
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r5_sweep_removes_staging_and_orphans() {
    let t = setup().await;
    let (tok, _) = t.register("sweeper").await;
    let g = t.create_game(&tok, "Sweep", "", true).await;
    let id = g["id"].as_str().unwrap();
    let gd = t.state.storage.game_dir(id);
    std::fs::create_dir_all(gd.join(".staging-dead").join("x")).unwrap();
    let orphan = t.state.storage.game_dir("orphan-id");
    std::fs::create_dir_all(orphan.join("v1")).unwrap();

    let n = webgame_server::sweep_stale_files(&t.state).await.unwrap();
    assert_eq!(n, 2);
    assert_eq!(dir_names(&gd), vec!["v1".to_string()]);
    assert!(!orphan.exists());
    let f = t.get(&format!("/games/{id}/files/main.js"), None).await;
    assert_eq!(f.status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// R6: ETag / 304
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r6_game_files_etag_and_304() {
    let t = setup().await;
    let (tok, _) = t.register("cacher").await;
    let g = t.create_game(&tok, "Cache", "", true).await;
    let id = g["id"].as_str().unwrap();
    let url = format!("/games/{id}/files/main.js");
    let t = &t;

    let r = t.get(&url, None).await;
    assert_eq!(r.status, StatusCode::OK);
    let etag = r.header("etag");
    assert!(etag.starts_with("\"v1-") && etag.ends_with('"'), "{etag}");
    assert_eq!(r.header("cache-control"), "no-cache");
    assert_eq!(r.header("content-type"), "text/javascript; charset=utf-8");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("content-security-policy"), "sandbox");
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert_eq!(r.header("content-length"), r.body.len().to_string());

    let cond = |v: String| {
        let url = url.clone();
        async move {
            t.send(
                Method::GET,
                &url,
                None,
                None,
                vec![],
                &[("if-none-match", v.as_str())],
            )
            .await
        }
    };
    let r = cond(etag.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert!(r.body.is_empty());
    assert_eq!(r.header("etag"), etag);
    assert_eq!(r.header("content-security-policy"), "sandbox");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert_eq!(
        cond(format!("W/{etag}")).await.status,
        StatusCode::NOT_MODIFIED
    );
    assert_eq!(
        cond(format!("\"other\", {etag}")).await.status,
        StatusCode::NOT_MODIFIED
    );
    assert_eq!(cond("\"other\"".into()).await.status, StatusCode::OK);

    // A new version invalidates the old validator.
    let r = replace(t, &tok, id, &valid_bundle()).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = cond(etag.clone()).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.header("etag").starts_with("\"v2-"));

    // Runtime files get validators too.
    let r = t.get("/runtime/engine.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    let rt = r.header("etag");
    assert!(rt.starts_with("\"rt-"), "{rt}");
    let r = t
        .send(
            Method::GET,
            "/runtime/engine.js",
            None,
            None,
            vec![],
            &[("if-none-match", rt.as_str())],
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
}

// ---------------------------------------------------------------------------
// R7: list query plans
// ---------------------------------------------------------------------------

async fn plan(t: &TestApp, q: ListQuery, viewer: Option<&str>) -> String {
    let (where_sql, binds) = list_filter(&q, viewer).unwrap();
    let order = list_order(q.sort.as_deref()).unwrap();
    let sql = format!(
        "EXPLAIN QUERY PLAN {} {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        webgame_server::models::GAME_SELECT
    );
    let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(&sql);
    for b in &binds {
        query = query.bind(b);
    }
    let rows = query.bind(24).bind(0).fetch_all(&t.state.db).await.unwrap();
    rows.into_iter()
        .map(|(_, _, _, d)| d)
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn r7_list_queries_use_indices() {
    let t = setup().await;
    let (tok, uid) = t.register("planner").await;
    t.create_game(&tok, "P", "arcade", true).await;
    let q = |sort: &str| ListQuery {
        sort: Some(sort.into()),
        ..Default::default()
    };
    let cases: Vec<(&str, ListQuery, Option<&str>, &str)> = vec![
        ("new", q("new"), None, "idx_games_pub_new"),
        ("popular", q("popular"), None, "idx_games_pub_plays"),
        ("favorites", q("favorites"), None, "idx_games_pub_favs"),
        ("top", q("top"), None, "idx_games_pub_top"),
        (
            "owner",
            ListQuery {
                owner: Some("Planner".into()),
                ..Default::default()
            },
            None,
            "idx_games_owner_pub_new",
        ),
        (
            "owner=me",
            ListQuery {
                owner: Some("me".into()),
                ..Default::default()
            },
            Some(uid.as_str()),
            "idx_games_owner_new",
        ),
        (
            "tag",
            ListQuery {
                tag: Some("arcade".into()),
                ..Default::default()
            },
            None,
            "idx_game_tags_tag_game",
        ),
    ];
    for (name, query, viewer, index) in cases {
        let p = plan(&t, query, viewer).await;
        println!("--- {name}\n{p}");
        assert!(p.contains(index), "{name}: expected {index}\n{p}");
        assert!(
            !p.contains("SCAN g\n") && !p.ends_with("SCAN g"),
            "{name}: scans games\n{p}"
        );
        if name != "tag" {
            assert!(
                !p.contains("TEMP B-TREE"),
                "{name}: sorts in a temp b-tree\n{p}"
            );
        }
        // The favorites count is a stored column now, never a per-row subquery.
        assert!(!p.contains("idx_favorites_game"), "{name}\n{p}");
    }
}

#[tokio::test]
async fn r7_favorites_count_column_tracks_favorites() {
    let t = setup().await;
    let (tok, _) = t.register("favowner").await;
    let (fan, _) = t.register("favfan").await;
    let g = t.create_game(&tok, "Fav", "", true).await;
    let id = g["id"].as_str().unwrap();
    for tk in [&tok, &fan] {
        let r = t
            .send(
                Method::PUT,
                &format!("/api/games/{id}/favorite"),
                Some(tk),
                None,
                vec![],
                &[],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    }
    // Idempotent PUT does not double count.
    t.send(
        Method::PUT,
        &format!("/api/games/{id}/favorite"),
        Some(&fan),
        None,
        vec![],
        &[],
    )
    .await;
    let v = t.get("/api/games?sort=favorites", None).await.json();
    assert_eq!(v["items"][0]["favorites"], 2);
    t.send(
        Method::DELETE,
        &format!("/api/games/{id}/favorite"),
        Some(&fan),
        None,
        vec![],
        &[],
    )
    .await;
    assert_eq!(
        t.get(&format!("/api/games/{id}"), None).await.json()["favorites"],
        1
    );
}

// ---------------------------------------------------------------------------
// R8: file/folder collision
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r8_file_and_folder_with_same_path_is_422() {
    let t = setup().await;
    let (tok, _) = t.register("collider").await;
    for (a, b) in [
        ("assets.txt", "assets.txt/b.txt"),
        ("Data.txt", "data.txt/deep/c.txt"),
    ] {
        let zip = make_zip(&[
            ("game.json", GAME_JSON.as_bytes()),
            ("main.js", b"export default {};"),
            (a, b"1"),
            (b, b"2"),
        ]);
        let r = t
            .multipart(
                Method::POST,
                "/api/games",
                Some(&tok),
                &[
                    Part::Text("title", "Collide"),
                    Part::File("bundle", "game.zip", "application/zip", &zip),
                ],
            )
            .await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
        assert!(r.text().contains("also a folder"), "{}", r.text());
    }
}

// ---------------------------------------------------------------------------
// R12: profile paging + score retention
// ---------------------------------------------------------------------------

#[tokio::test]
async fn r12_profile_games_paged() {
    let t = setup().await;
    let (tok, _) = t.register("prolific").await;
    for i in 0..3 {
        t.create_game(&tok, &format!("G{i}"), "", true).await;
    }
    t.create_game(&tok, "Hidden", "", false).await;

    let v = t.get("/api/users/prolific", None).await.json();
    assert_eq!(v["games"].as_array().unwrap().len(), 3);
    assert_eq!(v["gamesTotal"], 3);
    let v = t.get("/api/users/prolific?perPage=2", None).await.json();
    assert_eq!(v["games"].as_array().unwrap().len(), 2);
    assert_eq!(v["games"][0]["title"], "G2");
    assert_eq!(v["gamesTotal"], 3);
    let v = t
        .get("/api/users/prolific?perPage=2&page=2", None)
        .await
        .json();
    assert_eq!(v["games"].as_array().unwrap().len(), 1);
    assert_eq!(v["games"][0]["title"], "G0");
    // The owner also sees unpublished games.
    let v = t.get("/api/users/prolific", Some(&tok)).await.json();
    assert_eq!(v["gamesTotal"], 4);
    assert_eq!(
        t.get("/api/users/prolific?perPage=x", None).await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn r12_scores_pruned_but_windows_intact() {
    let t = setup().await;
    let (tok, uid) = t.register("grinder").await;
    let t = &t;
    let tok = tok.as_str();
    let g = t.create_game(tok, "Grind", "", true).await;
    let id = g["id"].as_str().unwrap();

    // 30 old scores (20 days ago): 100..=129.
    let old = (chrono::Utc::now() - chrono::Duration::days(20))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for s in 100..130 {
        sqlx::query(
            "INSERT INTO scores (id, game_id, user_id, score, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(id)
        .bind(&uid)
        .bind(s)
        .bind(&old)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM scores WHERE game_id = ?")
            .bind(id)
            .fetch_one(&t.state.db)
            .await
            .unwrap()
    };
    let submit = |s: i64| async move {
        let r = t
            .json(
                Method::POST,
                &format!("/api/games/{id}/scores"),
                Some(tok),
                json!({ "score": s }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        r.json()
    };

    // Today's first score: low overall, but it is today's (and this week's) best → kept.
    submit(1).await;
    assert_eq!(count().await, 21, "20 best old + today's best");
    submit(0).await; // worse than today's best and not in the top 20 → pruned
    assert_eq!(count().await, 21);
    let v = submit(2).await; // new day/week best; the old day best (1) is pruned
    assert_eq!(v["ranks"]["day"], 1);
    assert_eq!(count().await, 21);

    let min_old: i64 =
        sqlx::query_scalar("SELECT MIN(score) FROM scores WHERE game_id = ? AND created_at < ?")
            .bind(id)
            .bind(
                (chrono::Utc::now() - chrono::Duration::days(8))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(min_old, 110);

    let lb = |p: &str| {
        let url = format!("/api/games/{id}/leaderboard?period={p}");
        async move { t.get(&url, Some(tok)).await.json() }
    };
    assert_eq!(lb("day").await["me"]["score"], 2);
    assert_eq!(lb("week").await["me"]["score"], 2);
    assert_eq!(lb("all").await["me"]["score"], 129);
}
