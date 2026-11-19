//! F032 home and discover 2 (+ F029 featured games): migration 0027, `GET /api/games?sort=updated`,
//! `GET /api/collections`, `GET /api/creators/spotlight`, `PUT /api/users/me/featured` and
//! `UserProfileResponse.featured` (docs/API.md § F032 additions).

mod common;

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::*;
use serde_json::{Value, json};
use sqlx::Row;
use webgame_server::routes::creators::{spotlight_index, utc_day_number};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_string()
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|g| s(&g["id"])).collect()
}

fn assert_err(r: &Resp, status: StatusCode, code: &str, message: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    let v = r.json();
    assert_eq!(v["error"]["code"], code, "{}", r.text());
    assert_eq!(v["error"]["message"], message, "{}", r.text());
}

fn assert_422(r: &Resp, message: &str) {
    assert_err(r, StatusCode::UNPROCESSABLE_ENTITY, "validation", message);
}

async fn get_ok(t: &TestApp, uri: &str, tok: Option<&str>) -> Value {
    let r = t.get(uri, tok).await;
    assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
    r.json()
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

/// A game inserted directly. `day` sets `created_at`; `updated` sets `last_updated_at`.
async fn insert_game(
    t: &TestApp,
    gid: &str,
    owner: &str,
    published: bool,
    plays: i64,
    day: u32,
    updated: Option<u32>,
) {
    sqlx::query(
        "INSERT INTO games (id, owner_id, title, description, entry, width, height, created_at, \
         updated_at, first_published_at, last_updated_at, published, plays, actions_json, \
         controls_hint) \
         VALUES (?1, ?2, ?1, ?3, 'main.js', 800, 600, ?4, ?4, ?4, ?5, ?6, ?7, '[]', '')",
    )
    .bind(gid)
    .bind(owner)
    .bind(format!("{gid} description"))
    .bind(format!("2026-03-{day:02}T00:00:00.000Z"))
    .bind(updated.map(|d| format!("2026-04-{d:02}T00:00:00.000Z")))
    .bind(published)
    .bind(plays)
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn tag(t: &TestApp, gid: &str, tag: &str) {
    sqlx::query("INSERT INTO game_tags (game_id, tag, position) VALUES (?, ?, 0)")
        .bind(gid)
        .bind(tag)
        .execute(&t.state.db)
        .await
        .unwrap();
}

async fn set_published(t: &TestApp, gid: &str, published: bool) {
    sqlx::query("UPDATE games SET published = ? WHERE id = ?")
        .bind(published)
        .bind(gid)
        .execute(&t.state.db)
        .await
        .unwrap();
}

async fn insert_collection(t: &TestApp, cid: &str, owner: &str, visibility: &str, updated: u32) {
    sqlx::query(
        "INSERT INTO collections (id, owner_id, title, visibility, created_at, updated_at) \
         VALUES (?1, ?2, ?1, ?3, '2026-01-01T00:00:00.000Z', ?4)",
    )
    .bind(cid)
    .bind(owner)
    .bind(visibility)
    .bind(format!("2026-05-{updated:02}T00:00:00.000Z"))
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn add_to(t: &TestApp, cid: &str, games: &[&str]) {
    for (i, g) in games.iter().enumerate() {
        sqlx::query(
            "INSERT INTO collection_games (collection_id, game_id, position, added_at) \
             VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
        )
        .bind(cid)
        .bind(g)
        .bind(i as i64)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
}

async fn put_featured(t: &TestApp, tok: Option<&str>, body: Value) -> Resp {
    t.json(Method::PUT, "/api/users/me/featured", tok, body)
        .await
}

async fn put_featured_ok(t: &TestApp, tok: &str, game_ids: &[&str]) -> Vec<String> {
    let r = put_featured(t, Some(tok), json!({ "gameIds": game_ids })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    ids(&r.json()["featured"])
}

async fn profile_featured(t: &TestApp, username: &str, tok: Option<&str>) -> Vec<String> {
    ids(&get_ok(t, &format!("/api/users/{username}"), tok).await["featured"])
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_creates_table_and_indexes() {
    let t = setup().await;
    let pk: Vec<(String, i64)> = sqlx::query_as(
        "SELECT name, pk FROM pragma_table_info('profile_featured') WHERE pk > 0 ORDER BY pk",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(pk, [("user_id".to_string(), 1), ("game_id".to_string(), 2)]);
    for idx in [
        "idx_profile_featured_game",
        "idx_games_pub_updated",
        "idx_collections_public_updated",
    ] {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = ?")
            .bind(idx)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "{idx}");
    }

    // The sort=updated page uses the partial index.
    let q = webgame_server::routes::games::ListQuery {
        sort: Some("updated".into()),
        ..Default::default()
    };
    let (where_sql, binds) = webgame_server::routes::games::list_filter(&q, None).unwrap();
    let order = webgame_server::routes::games::list_order(Some("updated")).unwrap();
    let sql = format!(
        "EXPLAIN QUERY PLAN {} {where_sql} ORDER BY {order} LIMIT 24 OFFSET 0",
        webgame_server::models::GAME_SELECT
    );
    let mut query = sqlx::query(&sql);
    for b in &binds {
        query = query.bind(b);
    }
    let plan: Vec<String> = query
        .fetch_all(&t.state.db)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap())
        .collect();
    let text = plan.join("\n");
    assert!(text.contains("idx_games_pub_updated"), "{text}");
}

// ---------------------------------------------------------------------------
// sort=updated
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sort_updated_lists_only_updated_games_newest_first() {
    let t = setup().await;
    insert_user(&t, "u1", "ava").await;
    insert_game(&t, "never", "u1", true, 0, 1, None).await;
    insert_game(&t, "old", "u1", true, 0, 2, Some(1)).await;
    insert_game(&t, "mid", "u1", true, 0, 3, Some(5)).await;
    insert_game(&t, "hidden", "u1", false, 0, 4, Some(9)).await;
    tag(&t, "old", "puzzle").await;

    let v = get_ok(&t, "/api/games?sort=updated", None).await;
    assert_eq!(ids(&v["items"]), ["mid", "old"]);
    assert_eq!(v["total"], 2);
    // `total` counts only updated games on a full page too.
    let v = get_ok(&t, "/api/games?sort=updated&perPage=1", None).await;
    assert_eq!(ids(&v["items"]), ["mid"]);
    assert_eq!(v["total"], 2);
    let v = get_ok(&t, "/api/games?sort=updated&perPage=1&page=2", None).await;
    assert_eq!(ids(&v["items"]), ["old"]);
    assert_eq!(v["total"], 2);
    // Combines with tag and q.
    let v = get_ok(&t, "/api/games?sort=updated&tag=puzzle", None).await;
    assert_eq!(ids(&v["items"]), ["old"]);
    assert_eq!(v["total"], 1);
    let v = get_ok(&t, "/api/games?sort=updated&q=mid", None).await;
    assert_eq!(ids(&v["items"]), ["mid"]);
    let v = get_ok(&t, "/api/games?sort=updated&q=never", None).await;
    assert_eq!(v["total"], 0);
    // ` updated ` is trimmed like every sort.
    let v = get_ok(&t, "/api/games?sort=%20updated%20", None).await;
    assert_eq!(ids(&v["items"]), ["mid", "old"]);

    let r = t.get("/api/games?sort=bogus", None).await;
    assert_err(
        &r,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "Unknown sort 'bogus' (expected new, popular, top, favorites, trending or updated)",
    );
}

#[tokio::test]
async fn a_bundle_replace_moves_a_game_to_the_top() {
    let t = setup().await;
    let (tok, _) = t.register("ava").await;
    let a = s(&t.create_game(&tok, "Alpha", "arcade", true).await["id"]);
    let b = s(&t.create_game(&tok, "Beta", "arcade", true).await["id"]);
    assert_eq!(
        get_ok(&t, "/api/games?sort=updated", None).await["total"],
        0
    );
    for id in [&a, &b, &a] {
        let zip = valid_bundle();
        let r = t
            .multipart(
                Method::PUT,
                &format!("/api/games/{id}/bundle"),
                Some(&tok),
                &[Part::File("bundle", "game.zip", "application/zip", &zip)],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        // Distinct millisecond stamps.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let v = get_ok(&t, "/api/games?sort=updated", None).await;
    assert_eq!(ids(&v["items"]), [a, b]);
    assert_eq!(v["total"], 2);
}

// ---------------------------------------------------------------------------
// GET /api/collections
// ---------------------------------------------------------------------------

#[tokio::test]
async fn explore_collections_filter_and_order() {
    let t = setup().await;
    insert_user(&t, "u1", "ava").await;
    insert_user(&t, "u2", "ben").await;
    for g in ["p1", "p2", "p3", "p4"] {
        insert_game(&t, g, "u1", true, 0, 1, None).await;
    }
    insert_game(&t, "x1", "u1", false, 0, 1, None).await;
    insert_collection(&t, "c-old", "u2", "public", 1).await;
    add_to(&t, "c-old", &["p1", "p2", "p3"]).await;
    insert_collection(&t, "c-new", "u2", "public", 9).await;
    add_to(&t, "c-new", &["p4", "p3", "p2", "p1"]).await;
    insert_collection(&t, "c-private", "u2", "private", 8).await;
    add_to(&t, "c-private", &["p1", "p2", "p3"]).await;
    insert_collection(&t, "c-two", "u2", "public", 7).await;
    add_to(&t, "c-two", &["p1", "p2"]).await;
    insert_collection(&t, "c-unpub", "u2", "public", 6).await;
    add_to(&t, "c-unpub", &["p1", "p2", "x1"]).await;

    let v = get_ok(&t, "/api/collections", None).await;
    assert_eq!(ids(&v["items"]), ["c-new", "c-old"]);
    assert_eq!(v["total"], 2);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 12);
    assert_eq!(v["items"][0]["gameCount"], 4);
    assert_eq!(v["items"][0]["owner"]["username"], "ben");
    assert_eq!(v["items"][0]["path"], "/c/c-new");

    // The owner of the unpublished game sees it counted (F008 viewer rule) but the list is
    // the same: membership needs 3 published games.
    let (tok, _) = t.register("cara").await;
    let v = get_ok(&t, "/api/collections", Some(&tok)).await;
    assert_eq!(ids(&v["items"]), ["c-new", "c-old"]);

    // Ties on updatedAt go by id desc.
    sqlx::query(
        "UPDATE collections SET updated_at = '2026-05-09T00:00:00.000Z' WHERE id = 'c-old'",
    )
    .execute(&t.state.db)
    .await
    .unwrap();
    let v = get_ok(&t, "/api/collections", None).await;
    assert_eq!(ids(&v["items"]), ["c-old", "c-new"]);
}

#[tokio::test]
async fn explore_collections_paging() {
    let t = setup().await;
    insert_user(&t, "u1", "ava").await;
    for g in ["p1", "p2", "p3"] {
        insert_game(&t, g, "u1", true, 0, 1, None).await;
    }
    for i in 1..=5 {
        let cid = format!("c{i}");
        insert_collection(&t, &cid, "u1", "public", i).await;
        add_to(&t, &cid, &["p1", "p2", "p3"]).await;
    }
    let p1 = get_ok(&t, "/api/collections?perPage=2", None).await;
    let p2 = get_ok(&t, "/api/collections?perPage=2&page=2", None).await;
    let p3 = get_ok(&t, "/api/collections?perPage=2&page=3", None).await;
    assert_eq!(ids(&p1["items"]), ["c5", "c4"]);
    assert_eq!(ids(&p2["items"]), ["c3", "c2"]);
    assert_eq!(ids(&p3["items"]), ["c1"]);
    for p in [&p1, &p2, &p3] {
        assert_eq!(p["total"], 5);
    }
    assert_eq!(
        get_ok(&t, "/api/collections?perPage=100", None).await["perPage"],
        48
    );
    let v = get_ok(&t, "/api/collections?perPage=0", None).await;
    assert_eq!(v["perPage"], 1);
    assert_eq!(ids(&v["items"]), ["c5"]);
    assert_eq!(get_ok(&t, "/api/collections?page=0", None).await["page"], 1);
    assert_eq!(
        get_ok(&t, "/api/collections?foo=bar", None).await["total"],
        5
    );
    assert_err(
        &t.get("/api/collections?page=x", None).await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "page must be an integer",
    );
    assert_err(
        &t.get("/api/collections?perPage=x", None).await,
        StatusCode::BAD_REQUEST,
        "bad_request",
        "perPage must be an integer",
    );
    // POST still creates.
    let (tok, _) = t.register("ben").await;
    let r = t
        .json(
            Method::POST,
            "/api/collections",
            Some(&tok),
            json!({ "title": "Mine" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
}

// ---------------------------------------------------------------------------
// GET /api/creators/spotlight
// ---------------------------------------------------------------------------

fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

#[tokio::test]
async fn spotlight_without_creators() {
    let t = setup().await;
    insert_user(&t, "u1", "ava").await;
    insert_game(&t, "draft", "u1", false, 0, 1, None).await;
    let before = today();
    let v = get_ok(&t, "/api/creators/spotlight", None).await;
    let after = today();
    assert!(
        v["day"] == before.as_str() || v["day"] == after.as_str(),
        "{v}"
    );
    assert!(v["creator"].is_null());
    assert_eq!(v["games"], json!([]));
    assert_eq!(v.as_object().unwrap().len(), 3);
}

#[tokio::test]
async fn spotlight_pick_and_games() {
    let t = setup().await;
    // Creators a < b < c by id; d has only an unpublished game.
    for (id, name) in [("a", "anna"), ("b", "bob"), ("c", "cleo"), ("d", "dan")] {
        insert_user(&t, id, name).await;
    }
    for creator in ["a", "b", "c"] {
        // Plays order: x5 (50) > x4 (40) > x3 (30) > x2 (20) > x1 (10).
        for i in 1..=5 {
            insert_game(&t, &format!("{creator}{i}"), creator, true, i * 10, 1, None).await;
        }
        insert_game(
            &t,
            &format!("{creator}-draft"),
            creator,
            false,
            999,
            1,
            None,
        )
        .await;
    }
    insert_game(&t, "d1", "d", false, 0, 1, None).await;
    // Every creator features: someone else's game, an unpublished own game (saved while
    // published), then two own games in a chosen order.
    for creator in ["a", "b", "c"] {
        let rows = [
            (if creator == "a" { "b5" } else { "a5" }, 0),
            (&format!("{creator}-draft") as &str, 1),
            (&format!("{creator}1") as &str, 2),
            (&format!("{creator}3") as &str, 3),
        ];
        for (gid, pos) in rows {
            sqlx::query(
                "INSERT INTO profile_featured (user_id, game_id, position, created_at) \
                 VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
            )
            .bind(creator)
            .bind(gid)
            .bind(pos)
            .execute(&t.state.db)
            .await
            .unwrap();
        }
    }

    let (tok, _) = t.register("zoe").await;
    let r = t
        .send(
            Method::PUT,
            "/api/users/anna/follow",
            Some(&tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .send(
            Method::PUT,
            "/api/users/bob/follow",
            Some(&tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = t
        .send(
            Method::PUT,
            "/api/users/cleo/follow",
            Some(&tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());

    let before = utc_day_number(Utc::now());
    let anon = get_ok(&t, "/api/creators/spotlight", None).await;
    let signed = get_ok(&t, "/api/creators/spotlight", Some(&tok)).await;
    let after = utc_day_number(Utc::now());
    let ids_sorted = ["a", "b", "c"];
    let expected: Vec<&str> = [before, after]
        .iter()
        .map(|d| ids_sorted[spotlight_index(*d, 3) as usize])
        .collect();
    let picked = s(&anon["creator"]["user"]["id"]);
    assert!(
        expected.contains(&picked.as_str()),
        "{picked} vs {expected:?}"
    );
    assert_eq!(anon["creator"]["isFollowing"], false);
    assert_eq!(anon["creator"]["games"], 5);
    assert_eq!(anon["creator"]["followers"], 1);
    if before == after {
        assert_eq!(signed["creator"]["user"]["id"], picked.as_str());
        assert_eq!(signed["creator"]["isFollowing"], true);
        assert_eq!(signed["day"], anon["day"]);
    }
    // Own featured games in featured order, then the most played others; never another
    // owner's game or an unpublished one; at most 3.
    assert_eq!(
        ids(&anon["games"]),
        [
            format!("{picked}1"),
            format!("{picked}3"),
            format!("{picked}5")
        ]
    );

    // Without featured games: by plays.
    sqlx::query("DELETE FROM profile_featured")
        .execute(&t.state.db)
        .await
        .unwrap();
    let v = get_ok(&t, "/api/creators/spotlight", None).await;
    let picked = s(&v["creator"]["user"]["id"]);
    assert_eq!(
        ids(&v["games"]),
        [
            format!("{picked}5"),
            format!("{picked}4"),
            format!("{picked}3")
        ]
    );
}

#[tokio::test]
async fn spotlight_never_marks_yourself_as_followed() {
    let t = setup().await;
    let (tok, _) = t.register("ava").await;
    t.create_game(&tok, "Solo", "arcade", true).await;
    let v = get_ok(&t, "/api/creators/spotlight", Some(&tok)).await;
    assert_eq!(v["creator"]["user"]["username"], "ava");
    assert_eq!(v["creator"]["isFollowing"], false);
    assert_eq!(v["games"].as_array().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// PUT /api/users/me/featured and profile featured
// ---------------------------------------------------------------------------

#[tokio::test]
async fn featured_save_and_read_order() {
    let t = setup().await;
    let (ava, ava_id) = t.register("ava").await;
    let (_ben, ben_id) = t.register("ben").await;
    insert_game(&t, "own1", &ava_id, true, 0, 1, None).await;
    insert_game(&t, "own2", &ava_id, true, 0, 2, None).await;
    insert_game(&t, "ben1", &ben_id, true, 0, 3, None).await;
    insert_game(&t, "ben2", &ben_id, true, 0, 4, None).await;

    assert_eq!(
        profile_featured(&t, "ava", None).await,
        Vec::<String>::new()
    );
    let saved = put_featured_ok(&t, &ava, &["ben2", "own1", "ben1", "own2"]).await;
    assert_eq!(saved, ["ben2", "own1", "ben1", "own2"]);
    assert_eq!(profile_featured(&t, "ava", None).await, saved);
    assert_eq!(profile_featured(&t, "AVA", Some(&ava)).await, saved);
    // A new save replaces the list.
    assert_eq!(
        put_featured_ok(&t, &ava, &["own2", "ben2"]).await,
        ["own2", "ben2"]
    );
    assert_eq!(profile_featured(&t, "ava", None).await, ["own2", "ben2"]);
    // Summaries carry the owner.
    let p = get_ok(&t, "/api/users/ava", None).await;
    assert_eq!(p["featured"][1]["owner"]["username"], "ben");
    // `[]` clears.
    assert_eq!(put_featured_ok(&t, &ava, &[]).await, Vec::<String>::new());
    assert_eq!(
        profile_featured(&t, "ava", None).await,
        Vec::<String>::new()
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM profile_featured")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn featured_validation() {
    let t = setup().await;
    let (ava, ava_id) = t.register("ava").await;
    for g in ["g1", "g2", "g3", "g4", "g5"] {
        insert_game(&t, g, &ava_id, true, 0, 1, None).await;
    }
    insert_game(&t, "draft", &ava_id, false, 0, 1, None).await;

    let r = put_featured(&t, None, json!({ "gameIds": [] })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.error_code(), "unauthorized");

    put_featured_ok(&t, &ava, &["g1", "g2"]).await;

    assert_422(
        &put_featured(
            &t,
            Some(&ava),
            json!({ "gameIds": ["g1", "g2", "g3", "g4", "g5"] }),
        )
        .await,
        "gameIds must have at most 4 items",
    );
    // Count before duplicates.
    assert_422(
        &put_featured(
            &t,
            Some(&ava),
            json!({ "gameIds": ["g1", "g1", "g1", "g1", "g1"] }),
        )
        .await,
        "gameIds must have at most 4 items",
    );
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": ["g1", "g2", "g1"] })).await,
        "gameIds[2] is a duplicate",
    );
    // Duplicates before the published check.
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": ["nope", "g2", "g2"] })).await,
        "gameIds[2] is a duplicate",
    );
    // Unknown and unpublished ids: the same message.
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": ["g3", "nope"] })).await,
        "gameIds[1] is not a published game",
    );
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": ["g3", "draft"] })).await,
        "gameIds[1] is not a published game",
    );
    // The first failing id in request order.
    assert_422(
        &put_featured(
            &t,
            Some(&ava),
            json!({ "gameIds": ["g3", "draft", "nope"] }),
        )
        .await,
        "gameIds[1] is not a published game",
    );
    // Ids are compared exactly.
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": ["G3"] })).await,
        "gameIds[0] is not a published game",
    );
    assert_422(
        &put_featured(&t, Some(&ava), json!({ "gameIds": [" g3"] })).await,
        "gameIds[0] is not a published game",
    );
    // Shape errors are 422 too.
    for body in [
        json!({}),
        json!({ "gameIds": "g1" }),
        json!({ "gameIds": [1] }),
        json!([]),
    ] {
        let r = put_featured(&t, Some(&ava), body.clone()).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation");
    }
    // Every failure left the earlier list alone.
    assert_eq!(profile_featured(&t, "ava", None).await, ["g1", "g2"]);
}

#[tokio::test]
async fn featured_read_rule() {
    let t = setup().await;
    let (ava, ava_id) = t.register("ava").await;
    let (ben, ben_id) = t.register("ben").await;
    insert_game(&t, "a1", &ava_id, true, 0, 1, None).await;
    insert_game(&t, "b1", &ben_id, true, 0, 1, None).await;
    insert_game(&t, "a2", &ava_id, true, 0, 1, None).await;
    put_featured_ok(&t, &ava, &["a1", "b1", "a2"]).await;

    // Unpublishing hides it for everyone, the owner of the profile and of the game included.
    set_published(&t, "a1", false).await;
    for tok in [None, Some(ava.as_str()), Some(ben.as_str())] {
        assert_eq!(profile_featured(&t, "ava", tok).await, ["b1", "a2"]);
    }
    // ... but it stays saved and comes back in place.
    set_published(&t, "a1", true).await;
    assert_eq!(profile_featured(&t, "ava", None).await, ["a1", "b1", "a2"]);

    // Deleting a game removes its row.
    let r = t
        .send(
            Method::DELETE,
            "/api/games/b1",
            Some(&ben),
            None,
            vec![],
            &[],
        )
        .await;
    assert!(r.status.is_success(), "{}", r.text());
    assert_eq!(profile_featured(&t, "ava", None).await, ["a1", "a2"]);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM profile_featured WHERE game_id = 'b1'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // Deleting the user cascades too.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&ava_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM profile_featured")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    // A user with nothing featured.
    assert_eq!(
        get_ok(&t, "/api/users/ben", None).await["featured"],
        json!([])
    );
}

/// Concurrent saves serialise in `BEGIN IMMEDIATE`: the result is one complete list.
#[tokio::test]
async fn concurrent_saves_never_mix() {
    let t = setup().await;
    let (ava, ava_id) = t.register("ava").await;
    for g in ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"] {
        insert_game(&t, g, &ava_id, true, 0, 1, None).await;
    }
    let lists = [["g1", "g2", "g3", "g4"], ["g5", "g6", "g7", "g8"]];
    let (a, b) = tokio::join!(
        put_featured(&t, Some(&ava), json!({ "gameIds": lists[0] })),
        put_featured(&t, Some(&ava), json!({ "gameIds": lists[1] }))
    );
    assert_eq!(a.status, StatusCode::OK, "{}", a.text());
    assert_eq!(b.status, StatusCode::OK, "{}", b.text());
    let got = profile_featured(&t, "ava", None).await;
    assert!(got == lists[0] || got == lists[1], "{got:?}");
}
