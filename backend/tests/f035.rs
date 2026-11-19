//! F035: Explore creators (`GET /api/creators`, API § F035 additions).

mod common;

use std::io::Cursor;

use axum::http::{Method, StatusCode};
use common::*;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};
use sqlx::Row;
use webgame_server::routes::creators::IS_FOLLOWING_SQL;

const UNKNOWN_SORT: &str = "Unknown sort 'top' (expected popular, active or new)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn creators(t: &TestApp, query: &str, tok: Option<&str>) -> Value {
    let r = t.get(&format!("/api/creators{query}"), tok).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

fn names(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["user"]["username"].as_str().unwrap().to_string())
        .collect()
}

fn item<'a>(v: &'a Value, username: &str) -> &'a Value {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["user"]["username"] == username)
        .unwrap_or_else(|| panic!("{username} not in {v}"))
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

async fn set_plays(t: &TestApp, game_id: &str, plays: i64) {
    sqlx::query("UPDATE games SET plays = ? WHERE id = ?")
        .bind(plays)
        .bind(game_id)
        .execute(&t.state.db)
        .await
        .unwrap();
}

fn id(g: &Value) -> String {
    g["id"].as_str().unwrap().to_string()
}

/// A user inserted directly (`username_lower` drives the case-insensitive tiebreak).
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

/// A game inserted directly with full control over its timestamps.
#[allow(clippy::too_many_arguments)]
async fn insert_game(
    t: &TestApp,
    gid: &str,
    owner: &str,
    published: bool,
    plays: i64,
    created_at: &str,
    first_published_at: Option<&str>,
    last_updated_at: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO games (id, owner_id, title, entry, width, height, created_at, updated_at, \
         first_published_at, last_updated_at, published, plays, actions_json, controls_hint) \
         VALUES (?1, ?2, ?1, 'main.js', 800, 600, ?3, ?3, ?4, ?5, ?6, ?7, '[]', '')",
    )
    .bind(gid)
    .bind(owner)
    .bind(created_at)
    .bind(first_published_at)
    .bind(last_updated_at)
    .bind(published)
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

fn ts(day: u32) -> String {
    format!("2026-03-{day:02}T00:00:00.000Z")
}

fn banner_png() -> Vec<u8> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(1500, 500, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    }));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

#[tokio::test]
async fn only_users_with_published_games_are_creators() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let m1 = t.create_game(&mia, "M1", "", true).await;
    let m2 = t.create_game(&mia, "M2", "", true).await;
    let m3 = t.create_game(&mia, "M3", "", false).await;
    let l1 = t.create_game(&leo, "L1", "", true).await;
    t.create_game(&kai, "K1", "", false).await;
    set_plays(&t, &id(&m1), 5).await;
    set_plays(&t, &id(&m2), 7).await;
    set_plays(&t, &id(&m3), 1000).await;

    let v = creators(&t, "", None).await;
    assert_eq!(v["total"], 2);
    let mut got = names(&v);
    got.sort();
    assert_eq!(got, ["leo", "mia"]);
    assert_eq!(item(&v, "mia")["games"], 2);
    assert_eq!(
        item(&v, "mia")["plays"],
        12,
        "plays only over published games"
    );
    assert_eq!(item(&v, "leo")["games"], 1);

    // Not even the owner sees their unpublished-only account as a creator.
    let v = creators(&t, "", Some(&kai)).await;
    assert!(!names(&v).contains(&"kai".to_string()));

    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{}", id(&l1)),
            Some(&leo),
            json!({ "published": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = creators(&t, "", None).await;
    assert_eq!(v["total"], 1);
    assert_eq!(names(&v), ["mia"]);
}

#[tokio::test]
async fn empty_catalogue() {
    let t = setup().await;
    t.register("nobody").await;
    let v = creators(&t, "", None).await;
    assert_eq!(
        v,
        json!({ "items": [], "total": 0, "page": 1, "perPage": 24 })
    );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

#[tokio::test]
async fn card_fields() {
    let t = setup().await;
    let (mia, mia_id) = t.register("mia").await;
    t.create_game(&mia, "M1", "", true).await;

    let v = creators(&t, "", None).await;
    let c = item(&v, "mia");
    assert_eq!(
        c["user"],
        json!({ "id": mia_id, "username": "mia", "displayName": "mia", "avatarUrl": null })
    );
    assert_eq!(c["bannerUrl"], Value::Null);
    assert_eq!(c["bioExcerpt"], "");
    assert_eq!(c["followers"], 0);
    assert_eq!(c["isFollowing"], false);
    let keys: Vec<&String> = c.as_object().unwrap().keys().collect();
    let mut keys: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "bannerUrl",
            "bioExcerpt",
            "firstPublishedAt",
            "followers",
            "games",
            "isFollowing",
            "lastActiveAt",
            "plays",
            "user"
        ]
    );

    // Banner after an upload.
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/banner",
            Some(&mia),
            &[Part::File(
                "banner",
                "banner.png",
                "image/png",
                &banner_png(),
            )],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = creators(&t, "", None).await;
    assert_eq!(
        item(&v, "mia")["bannerUrl"],
        format!("/media/banners/{mia_id}.jpg?v=1")
    );

    // Bio excerpt: the first 160 code points of a 200-character non-ASCII bio.
    let bio: String = "héllo wörld ✨ 日本語 "
        .chars()
        .cycle()
        .take(199)
        .chain(std::iter::once('Z'))
        .collect();
    assert_eq!(bio.chars().count(), 200);
    let r = t
        .json(
            Method::PATCH,
            "/api/users/me",
            Some(&mia),
            json!({ "bio": bio }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = creators(&t, "", None).await;
    let excerpt = item(&v, "mia")["bioExcerpt"].as_str().unwrap().to_string();
    assert_eq!(excerpt.chars().count(), 160);
    assert_eq!(excerpt, bio.chars().take(160).collect::<String>());
}

#[tokio::test]
async fn first_published_and_last_active() {
    let t = setup().await;
    insert_user(&t, "u1", "mia").await;
    // Published games: publish times 03-05 and 03-02 (via created_at fallback); the first
    // one was updated on 03-20. An unpublished game with later times never counts.
    insert_game(&t, "g1", "u1", true, 0, &ts(1), Some(&ts(5)), Some(&ts(20))).await;
    insert_game(&t, "g2", "u1", true, 0, &ts(2), None, None).await;
    insert_game(
        &t,
        "g3",
        "u1",
        false,
        0,
        &ts(1),
        Some(&ts(25)),
        Some(&ts(28)),
    )
    .await;
    let v = creators(&t, "", None).await;
    let c = item(&v, "mia");
    assert_eq!(c["firstPublishedAt"], ts(2));
    assert_eq!(c["lastActiveAt"], ts(20));
    assert_eq!(c["games"], 2);
}

#[tokio::test]
async fn bundle_replace_moves_last_active() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let g = t.create_game(&mia, "M1", "", true).await;
    let gid = id(&g);
    // Pin the publish time in the past so the replace is observably later.
    sqlx::query(
        "UPDATE games SET first_published_at = ?1, created_at = ?1, last_updated_at = NULL \
         WHERE id = ?2",
    )
    .bind(ts(1))
    .bind(&gid)
    .execute(&t.state.db)
    .await
    .unwrap();
    let before = creators(&t, "", None).await;
    assert_eq!(item(&before, "mia")["lastActiveAt"], ts(1));
    assert_eq!(item(&before, "mia")["firstPublishedAt"], ts(1));

    let zip = valid_bundle();
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{gid}/bundle"),
            Some(&mia),
            &[Part::File("bundle", "game.zip", "application/zip", &zip)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let updated: String = sqlx::query_scalar("SELECT last_updated_at FROM games WHERE id = ?")
        .bind(&gid)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let after = creators(&t, "?sort=active", None).await;
    assert_eq!(item(&after, "mia")["lastActiveAt"], updated);
    assert_eq!(item(&after, "mia")["firstPublishedAt"], ts(1));
    assert!(updated > ts(1));
}

// ---------------------------------------------------------------------------
// Sorts
// ---------------------------------------------------------------------------

/// Five creators with controlled followers, plays and timestamps. `Zed` and `adam` tie on
/// everything, so only the case-insensitive username separates them (`Z` < `a` in ASCII).
async fn sort_fixture(t: &TestApp) {
    for (uid, name) in [
        ("u1", "adam"),
        ("u2", "Zed"),
        ("u3", "bea"),
        ("u4", "cy"),
        ("u5", "dee"),
        ("f1", "fan1"),
        ("f2", "fan2"),
    ] {
        insert_user(t, uid, name).await;
    }
    // adam & Zed: 1 follower, 10 plays, published 03-03, active 03-03.
    insert_game(t, "g1", "u1", true, 10, &ts(3), Some(&ts(3)), None).await;
    insert_game(t, "g2", "u2", true, 10, &ts(3), Some(&ts(3)), None).await;
    // bea: 2 followers, 1 play, first published 03-01, active 03-09.
    insert_game(t, "g3", "u3", true, 1, &ts(1), Some(&ts(1)), Some(&ts(9))).await;
    // cy: 1 follower, 50 plays, published 03-07.
    insert_game(t, "g4", "u4", true, 50, &ts(7), Some(&ts(7)), None).await;
    // dee: 0 followers, 999 plays, published 03-05 (two games), active 03-06.
    insert_game(t, "g5", "u5", true, 500, &ts(5), Some(&ts(5)), Some(&ts(6))).await;
    insert_game(t, "g6", "u5", true, 499, &ts(6), Some(&ts(6)), None).await;
    for (a, b) in [
        ("f1", "u1"),
        ("f1", "u2"),
        ("f1", "u3"),
        ("f2", "u3"),
        ("f1", "u4"),
    ] {
        insert_follow(t, a, b).await;
    }
}

#[tokio::test]
async fn sorts_and_tiebreaks() {
    let t = setup().await;
    sort_fixture(&t).await;

    let popular = ["bea", "cy", "adam", "Zed", "dee"];
    assert_eq!(names(&creators(&t, "", None).await), popular);
    assert_eq!(names(&creators(&t, "?sort=", None).await), popular);
    let v = creators(&t, "?sort=popular", None).await;
    assert_eq!(names(&v), popular);
    assert_eq!(item(&v, "bea")["followers"], 2);
    assert_eq!(item(&v, "dee")["plays"], 999);
    assert_eq!(item(&v, "dee")["games"], 2);

    assert_eq!(
        names(&creators(&t, "?sort=active", None).await),
        ["bea", "cy", "dee", "adam", "Zed"]
    );
    assert_eq!(
        names(&creators(&t, "?sort=new", None).await),
        ["cy", "dee", "adam", "Zed", "bea"]
    );
    // The total doesn't depend on the sort.
    for s in ["popular", "active", "new"] {
        assert_eq!(creators(&t, &format!("?sort={s}"), None).await["total"], 5);
    }
}

#[tokio::test]
async fn unknown_sort_is_rejected_before_paging() {
    let t = setup().await;
    for q in [
        "?sort=top",
        "?sort=top&page=x",
        "?page=x&sort=top&perPage=y",
    ] {
        let r = t.get(&format!("/api/creators{q}"), None).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{q}");
        assert_eq!(r.error_code(), "bad_request");
        assert_eq!(r.json()["error"]["message"], UNKNOWN_SORT, "{q}");
    }
    // Case matters: sorts are lowercase tokens.
    let r = t.get("/api/creators?sort=Popular", None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let r = t.get("/api/creators?page=x", None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"]["message"], "page must be an integer");
    let r = t.get("/api/creators?sort=new&perPage=x", None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"]["message"], "perPage must be an integer");
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

async fn many_creators(t: &TestApp, n: usize) {
    for i in 0..n {
        let uid = format!("u{i:02}");
        insert_user(t, &uid, &format!("maker{i:02}")).await;
        // Everyone ties on followers and plays (and half on time), so the username decides.
        let day = (i % 2) as u32 + 1;
        insert_game(t, &format!("g{i:02}"), &uid, true, 3, &ts(day), None, None).await;
    }
}

#[tokio::test]
async fn paging_clamps_and_covers_everyone() {
    let t = setup().await;
    many_creators(&t, 50).await;

    let v = creators(&t, "", None).await;
    assert_eq!(v["perPage"], 24);
    assert_eq!(v["page"], 1);
    assert_eq!(v["total"], 50);
    assert_eq!(v["items"].as_array().unwrap().len(), 24);

    let v = creators(&t, "?perPage=100", None).await;
    assert_eq!(v["perPage"], 48);
    assert_eq!(v["items"].as_array().unwrap().len(), 48);

    let v = creators(&t, "?perPage=0", None).await;
    assert_eq!(v["perPage"], 1);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);

    let v = creators(&t, "?page=0", None).await;
    assert_eq!(v["page"], 1);

    let v = creators(&t, "?page=99", None).await;
    assert_eq!(v["items"], json!([]));
    assert_eq!(v["total"], 50);
}

#[tokio::test]
async fn pages_do_not_overlap() {
    let t = setup().await;
    many_creators(&t, 30).await;
    for sort in ["popular", "active", "new"] {
        let p1 = creators(&t, &format!("?sort={sort}&page=1&perPage=24"), None).await;
        let p2 = creators(&t, &format!("?sort={sort}&page=2&perPage=24"), None).await;
        let (a, b) = (names(&p1), names(&p2));
        assert_eq!(a.len(), 24);
        assert_eq!(b.len(), 6);
        let mut all: Vec<String> = a.iter().chain(b.iter()).cloned().collect();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 30, "{sort}: pages overlap or skip");
    }
    // popular: all tie, so the username order alone.
    let p1 = creators(&t, "?perPage=3", None).await;
    assert_eq!(names(&p1), ["maker00", "maker01", "maker02"]);
}

// ---------------------------------------------------------------------------
// isFollowing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn is_following_per_viewer() {
    let t = setup().await;
    let (mia, _) = t.register("mia").await;
    let (leo, _) = t.register("leo").await;
    let (kai, _) = t.register("kai").await;
    let (viewer, _) = t.register("viewer").await;
    for tok in [&mia, &leo, &kai, &viewer] {
        t.create_game(tok, "G", "", true).await;
    }
    follow(&t, &viewer, "mia").await;
    follow(&t, &viewer, "kai").await;
    follow(&t, &leo, "mia").await;

    let anon = creators(&t, "", None).await;
    assert_eq!(anon["total"], 4);
    for c in anon["items"].as_array().unwrap() {
        assert_eq!(c["isFollowing"], false);
    }
    assert_eq!(item(&anon, "mia")["followers"], 2);
    assert_eq!(item(&anon, "kai")["followers"], 1);

    let v = creators(&t, "", Some(&viewer)).await;
    assert_eq!(item(&v, "mia")["isFollowing"], true);
    assert_eq!(item(&v, "kai")["isFollowing"], true);
    assert_eq!(item(&v, "leo")["isFollowing"], false);
    // The viewer's own card is included and never "following".
    assert_eq!(item(&v, "viewer")["isFollowing"], false);

    // Following doesn't change membership or anything else but the counts.
    let v2 = creators(&t, "", Some(&leo)).await;
    assert_eq!(item(&v2, "mia")["isFollowing"], true);
    assert_eq!(item(&v2, "kai")["isFollowing"], false);

    // An invalid token on this public route is anonymous, like other 🔓 reads.
    let r = t.get("/api/creators", Some("garbage")).await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn is_following_uses_the_primary_key_in_one_statement() {
    let t = setup().await;
    let plan: Vec<String> = sqlx::query(&format!("EXPLAIN QUERY PLAN {IS_FOLLOWING_SQL}"))
        .bind("viewer")
        .bind(r#"["a","b","c"]"#)
        .fetch_all(&t.state.db)
        .await
        .unwrap()
        .iter()
        .map(|r| r.try_get::<String, _>("detail").unwrap())
        .collect();
    let follows: Vec<&String> = plan.iter().filter(|d| d.contains("follows")).collect();
    assert_eq!(follows.len(), 1, "{plan:?}");
    let d = follows[0];
    assert!(
        d.starts_with("SEARCH follows USING")
            && (d.contains("PRIMARY KEY") || d.contains("sqlite_autoindex_follows_1"))
            && d.contains("follower_id=? AND followee_id=?"),
        "{plan:?}"
    );
    assert!(
        plan.iter().all(|d| !d.starts_with("SCAN follows")),
        "{plan:?}"
    );
}
