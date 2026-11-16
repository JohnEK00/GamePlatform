//! F003: trending and "More like this" (docs/features/F003-trending-and-related.md).

mod common;

use axum::http::{Method, StatusCode};
use chrono::{Duration, Utc};
use common::*;
use serde_json::Value;
use webgame_server::trending;

async fn app() -> TestApp {
    setup_with(|c| {
        c.trending_ttl = std::time::Duration::ZERO;
        c.rate_limit = false;
    })
    .await
}

fn day(age: i64) -> String {
    (Utc::now().date_naive() - Duration::days(age))
        .format("%Y-%m-%d")
        .to_string()
}

/// Insert a play event `age` UTC days ago directly (controls the window).
async fn event(t: &TestApp, game: &str, user: Option<&str>, age: i64, key: Option<&str>) {
    let d = day(age);
    sqlx::query(
        "INSERT INTO play_events (game_id, user_id, day, created_at, viewer_key) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(game)
    .bind(user)
    .bind(&d)
    .bind(format!("{d}T12:00:00.000Z"))
    .bind(key)
    .execute(&t.state.db)
    .await
    .unwrap();
}

async fn set_plays(t: &TestApp, game: &str, plays: i64) {
    sqlx::query("UPDATE games SET plays = ? WHERE id = ?")
        .bind(plays)
        .bind(game)
        .execute(&t.state.db)
        .await
        .unwrap();
}

async fn snapshot(t: &TestApp, game: &str) -> Option<(i64, f64)> {
    sqlx::query_as("SELECT plays_week, score FROM game_trending WHERE game_id = ?")
        .bind(game)
        .fetch_optional(&t.state.db)
        .await
        .unwrap()
}

async fn play(t: &TestApp, id: &str, tok: Option<&str>, ip: Option<&str>) -> Resp {
    let extra: Vec<(&str, &str)> = ip.map(|ip| ("x-forwarded-for", ip)).into_iter().collect();
    t.send(
        Method::POST,
        &format!("/api/games/{id}/play"),
        tok,
        None,
        vec![],
        &extra,
    )
    .await
}

async fn keys(t: &TestApp, game: &str) -> Vec<Option<String>> {
    sqlx::query_scalar("SELECT viewer_key FROM play_events WHERE game_id = ? ORDER BY id")
        .bind(game)
        .fetch_all(&t.state.db)
        .await
        .unwrap()
}

fn ids(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["id"].as_str().unwrap().to_string())
        .collect()
}

async fn new_game(t: &TestApp, tok: &str, title: &str, tags: &str, published: bool) -> String {
    t.create_game(tok, title, tags, published).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

// ---------------------------------------------------------------------------
// viewer_key + dedupe
// ---------------------------------------------------------------------------

#[tokio::test]
async fn viewer_key_stored_on_counted_plays() {
    let t = setup_with(|c| {
        c.trending_ttl = std::time::Duration::ZERO;
        c.rate_limit = false;
        c.trust_proxy = 1;
    })
    .await;
    let (owner, _) = t.register("owner").await;
    let (fan, fan_id) = t.register("fan").await;
    let a = new_game(&t, &owner, "A", "", true).await;
    let b = new_game(&t, &owner, "B", "", true).await;

    assert_eq!(play(&t, &a, Some(&fan), None).await.json()["plays"], 1);
    assert_eq!(play(&t, &a, None, Some("1.1.1.1")).await.json()["plays"], 2);
    assert_eq!(play(&t, &b, None, Some("1.1.1.1")).await.json()["plays"], 1);
    assert_eq!(play(&t, &a, None, Some("2.2.2.2")).await.json()["plays"], 3);

    let ka = keys(&t, &a).await;
    assert_eq!(ka.len(), 3);
    assert_eq!(ka[0].as_deref(), Some(format!("u:{fan_id}").as_str()));
    let anon = ka[1].clone().unwrap();
    assert!(anon.starts_with("a:"), "{anon}");
    assert_eq!(anon.len(), 18);
    assert!(anon[2..].chars().all(|c| c.is_ascii_hexdigit()));
    assert!(!anon.contains("1.1.1.1"));
    // Same IP → same key (on another game); another IP → another key.
    assert_eq!(keys(&t, &b).await[0].as_deref(), Some(anon.as_str()));
    assert_ne!(ka[2].as_deref(), Some(anon.as_str()));
    assert!(ka[2].as_deref().unwrap().starts_with("a:"));

    // Deduplicated plays (same viewer within 10 min) write no row and keep the count.
    let r = play(&t, &a, None, Some("1.1.1.1")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["plays"], 3);
    let r = play(&t, &a, Some(&fan), None).await;
    assert_eq!(r.json()["plays"], 3);
    assert_eq!(keys(&t, &a).await.len(), 3);
    let plays: i64 = sqlx::query_scalar("SELECT plays FROM games WHERE id = ?")
        .bind(&a)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(plays, 3);
}

// ---------------------------------------------------------------------------
// Trending score + order
// ---------------------------------------------------------------------------

#[tokio::test]
async fn trending_score_and_order() {
    let t = app().await;
    let (owner, owner_id) = t.register("owner").await;
    let a = new_game(&t, &owner, "A", "", true).await; // 3 viewers today
    let b = new_game(&t, &owner, "B", "", true).await; // 1 viewer, 5 days
    let old = new_game(&t, &owner, "Old", "", true).await; // only 8+ days old
    let zero = new_game(&t, &owner, "Zero", "", true).await; // no plays
    let own = new_game(&t, &owner, "Own", "", true).await; // only owner plays
    let today = new_game(&t, &owner, "Today", "", true).await; // 1 viewer today
    let six = new_game(&t, &owner, "Six", "", true).await; // 1 viewer 6 days ago

    for k in ["u:x", "u:y", "a:0000000000000001"] {
        event(&t, &a, None, 0, Some(k)).await;
    }
    for age in 2..=6 {
        event(&t, &b, None, age, Some("u:z")).await;
    }
    event(&t, &old, None, 8, Some("u:x")).await;
    event(&t, &old, None, 30, Some("u:y")).await;
    for _ in 0..5 {
        event(&t, &own, Some(&owner_id), 0, Some(&format!("u:{owner_id}"))).await;
    }
    event(&t, &today, None, 0, Some("u:q")).await;
    event(&t, &six, None, 6, Some("u:q")).await;
    // Fallback order among unscored games: all-time plays.
    set_plays(&t, &old, 50).await;
    set_plays(&t, &zero, 10).await;
    set_plays(&t, &own, 5).await;

    trending::refresh(&t.state.db, Utc::now()).await.unwrap();
    let (pw, s) = snapshot(&t, &a).await.unwrap();
    assert_eq!(pw, 3);
    assert!((s - 3.0).abs() < 1e-9, "{s}");
    let (pw, s) = snapshot(&t, &b).await.unwrap();
    assert_eq!(pw, 5);
    assert!((s - 15.0 / 7.0).abs() < 1e-9, "{s}");
    assert!(snapshot(&t, &old).await.is_none());
    assert!(
        snapshot(&t, &own).await.is_none(),
        "owner plays never count"
    );
    let (_, s_today) = snapshot(&t, &today).await.unwrap();
    let (_, s_six) = snapshot(&t, &six).await.unwrap();
    assert!((s_today - 1.0).abs() < 1e-9);
    assert!((s_six - 1.0 / 7.0).abs() < 1e-9);

    let r = t.get("/api/games?sort=trending", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(
        ids(&v["items"]),
        vec![a.clone(), b, today, six, old.clone(), zero, own.clone()]
    );
    assert_eq!(v["total"], 7);
    let items = v["items"].as_array().unwrap();
    assert_eq!(items[0]["playsWeek"], 3);
    assert_eq!(items[4]["playsWeek"], 0);
    assert_eq!(items[6]["playsWeek"], 0);
}

#[tokio::test]
async fn purge_old_keys_and_legacy_null_rows() {
    let t = app().await;
    let (owner, _) = t.register("owner").await;
    let g = new_game(&t, &owner, "G", "", true).await;
    event(&t, &g, None, 8, Some("u:old")).await;
    event(&t, &g, None, 3, Some("u:recent")).await;
    // Pre-F003 rows: NULL keys, each its own viewer (same day).
    event(&t, &g, None, 3, None).await;
    event(&t, &g, None, 3, None).await;

    trending::refresh(&t.state.db, Utc::now()).await.unwrap();
    let k = keys(&t, &g).await;
    assert_eq!(k, vec![None, Some("u:recent".into()), None, None]);
    let (pw, s) = snapshot(&t, &g).await.unwrap();
    assert_eq!(pw, 3);
    assert!((s - 3.0 * 4.0 / 7.0).abs() < 1e-9, "{s}");
}

#[tokio::test]
async fn trending_filters_and_errors() {
    let t = app().await;
    let (owner, _) = t.register("owner").await;
    let x = new_game(&t, &owner, "Rocket", "space", true).await;
    let y = new_game(&t, &owner, "Comet", "space", true).await;
    let _z = new_game(&t, &owner, "Puzzle", "puzzle", true).await;
    let hidden = new_game(&t, &owner, "Hidden", "space", false).await;
    event(&t, &y, None, 0, Some("u:a")).await;
    event(&t, &hidden, None, 0, Some("u:a")).await;
    event(&t, &hidden, None, 0, Some("u:b")).await;

    let v = t
        .get("/api/games?sort=trending&tag=space", None)
        .await
        .json();
    assert_eq!(ids(&v["items"]), vec![y.clone(), x.clone()]);
    let n = t.get("/api/games?sort=new&tag=space", None).await.json();
    assert_eq!(v["total"], n["total"]);
    assert_eq!(v["total"], 2);

    let v = t
        .get("/api/games?sort=trending&q=rock&perPage=1", None)
        .await
        .json();
    assert_eq!(ids(&v["items"]), vec![x.clone()]);
    assert_eq!(v["total"], 1);

    let v = t
        .get("/api/games?sort=trending&perPage=1", None)
        .await
        .json();
    let n = t.get("/api/games?sort=new&perPage=1", None).await.json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["total"], n["total"]);
    let all = t.get("/api/games?sort=trending", None).await.json();
    assert!(!ids(&all["items"]).contains(&hidden));

    let r = t.get("/api/games?sort=hot", None).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.error_code(), "bad_request");
    assert!(
        r.text()
            .contains("expected new, popular, top, favorites or trending"),
        "{}",
        r.text()
    );
}

#[tokio::test]
async fn plays_week_on_every_summary() {
    let t = app().await;
    let (owner, _) = t.register("owner").await;
    let (fan, _) = t.register("fan").await;
    let g = new_game(&t, &owner, "G", "", true).await;
    event(&t, &g, None, 1, Some("u:a")).await;
    event(&t, &g, None, 0, Some("u:b")).await;
    // Any trending read refreshes (TTL 0).
    t.get("/api/games?sort=trending", None).await;

    let r = t.get(&format!("/api/games/{g}"), None).await.json();
    assert_eq!(r["playsWeek"], 2);
    let r = t.get("/api/games", None).await.json();
    assert_eq!(r["items"][0]["playsWeek"], 2);
    let fav = t
        .send(
            Method::PUT,
            &format!("/api/games/{g}/favorite"),
            Some(&fan),
            None,
            vec![],
            &[],
        )
        .await;
    assert!(fav.status.is_success(), "{}", fav.text());
    let r = t.get("/api/users/me/favorites", Some(&fan)).await.json();
    assert_eq!(r["items"][0]["playsWeek"], 2);
    let r = t.get("/api/users/owner", None).await.json();
    assert_eq!(r["games"][0]["playsWeek"], 2);
    // A game without plays carries 0, not a missing field.
    let h = new_game(&t, &owner, "H", "", true).await;
    let r = t.get(&format!("/api/games/{h}"), None).await.json();
    assert_eq!(r["playsWeek"], 0);
}

// ---------------------------------------------------------------------------
// Related
// ---------------------------------------------------------------------------

#[tokio::test]
async fn related_ranking_cap_and_fill() {
    let t = app().await;
    let (o1, _) = t.register("owner1").await;
    let (o2, _) = t.register("owner2").await;
    let (o3, _) = t.register("owner3").await;
    let (o4, _) = t.register("owner4").await;
    let (o5, _) = t.register("owner5").await;
    let (o6, _) = t.register("owner6").await;

    let src = new_game(&t, &o1, "Source", "pixel,arcade,space", true).await;
    let s2 = new_game(&t, &o1, "S2", "arcade", true).await;
    let s3 = new_game(&t, &o1, "S3", "arcade", true).await;
    let s4 = new_game(&t, &o1, "S4", "arcade", true).await;
    let rare = new_game(&t, &o2, "Rare", "pixel", true).await;
    let c1 = new_game(&t, &o3, "C1", "arcade", true).await;
    let c2 = new_game(&t, &o3, "C2", "arcade", true).await;
    let c3 = new_game(&t, &o3, "C3", "arcade", true).await;
    let two = new_game(&t, &o4, "Two", "space,arcade", true).await;
    let unpub = new_game(&t, &o5, "Unpub", "pixel,arcade,space", false).await;
    let fill = new_game(&t, &o6, "Fill", "puzzle", true).await;
    for (g, p) in [
        (&c1, 30),
        (&s2, 25),
        (&c2, 20),
        (&s3, 15),
        (&c3, 10),
        (&s4, 5),
        (&rare, 1),
    ] {
        set_plays(&t, g, p).await;
    }

    let r = t
        .get(&format!("/api/games/{src}/related?limit=24"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    // `Two` shares two tags (arcade + space); a shared rare tag (pixel, n=2) beats a shared
    // common one (arcade, n=8) despite fewer plays; at most 2 per owner (source owner too).
    assert_eq!(
        ids(&v),
        vec![
            two.clone(),
            rare.clone(),
            c1.clone(),
            s2.clone(),
            c2.clone(),
            s3.clone(),
            fill.clone()
        ]
    );
    let items = v.as_array().unwrap();
    assert_eq!(items[0]["reason"], "tags");
    assert_eq!(
        items[0]["sharedTags"],
        serde_json::json!(["arcade", "space"])
    );
    assert_eq!(items[1]["sharedTags"], serde_json::json!(["pixel"]));
    assert_eq!(items[6]["reason"], "trending");
    assert_eq!(items[6]["sharedTags"], serde_json::json!([]));
    assert!(items[0]["playsWeek"].is_number());
    let got = ids(&v);
    assert!(!got.contains(&src) && !got.contains(&unpub));
    assert!(!got.contains(&c3) && !got.contains(&s4));

    // Default limit 8, clamp, non-integer.
    let v = t
        .get(&format!("/api/games/{src}/related"), None)
        .await
        .json();
    assert_eq!(v.as_array().unwrap().len(), 7);
    let v = t
        .get(&format!("/api/games/{src}/related?limit=2"), None)
        .await
        .json();
    assert_eq!(ids(&v), vec![two.clone(), rare.clone()]);
    let v = t
        .get(&format!("/api/games/{src}/related?limit=0"), None)
        .await
        .json();
    assert_eq!(ids(&v), vec![two.clone()]);
    let r = t
        .get(&format!("/api/games/{src}/related?limit=x"), None)
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.error_code(), "bad_request");

    // Nothing shares a tag with `Fill`: all trending fill (trending first, then plays).
    event(&t, &rare, None, 0, Some("u:a")).await;
    let v = t
        .get(&format!("/api/games/{fill}/related?limit=3"), None)
        .await
        .json();
    assert_eq!(ids(&v), vec![rare.clone(), c1.clone(), s2.clone()]);
    assert!(
        v.as_array()
            .unwrap()
            .iter()
            .all(|g| g["reason"] == "trending" && g["sharedTags"] == serde_json::json!([]))
    );

    // Unpublished source: 404 for others, 200 for the owner; unknown id 404.
    let r = t.get(&format!("/api/games/{unpub}/related"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .get(&format!("/api/games/{unpub}/related"), Some(&o1))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .get(&format!("/api/games/{unpub}/related"), Some(&o5))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(!ids(&r.json()).contains(&unpub));
    let r = t.get("/api/games/nope/related", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn related_single_game_is_empty() {
    let t = app().await;
    let (o, _) = t.register("solo").await;
    let g = new_game(&t, &o, "Solo", "arcade", true).await;
    let v = t.get(&format!("/api/games/{g}/related"), None).await.json();
    assert_eq!(v, serde_json::json!([]));
}

// ---------------------------------------------------------------------------
// Refresh failure + TTL
// ---------------------------------------------------------------------------

/// Dropping `game_trending` would break every `GAME_SELECT` (it reads `plays_week` from the
/// table), so the failure is injected with a trigger that aborts the snapshot insert instead.
#[tokio::test]
async fn refresh_failure_serves_stale_snapshot() {
    let t = app().await;
    let (o, _) = t.register("owner").await;
    let g = new_game(&t, &o, "G", "", true).await;
    event(&t, &g, None, 0, Some("u:a")).await;
    assert_eq!(
        t.get("/api/games?sort=trending", None).await.json()["items"][0]["playsWeek"],
        1
    );
    let before = t.state.trending.refresh_count();
    sqlx::query(
        "CREATE TRIGGER fail_trending BEFORE INSERT ON game_trending \
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    .execute(&t.state.db)
    .await
    .unwrap();
    event(&t, &g, None, 0, Some("u:b")).await;
    for uri in [
        "/api/games?sort=trending",
        &format!("/api/games/{g}/related"),
    ] {
        let r = t.get(uri, None).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
    }
    let v = t.get("/api/games?sort=trending", None).await.json();
    assert_eq!(v["items"][0]["playsWeek"], 1, "stale snapshot kept");
    assert_eq!(t.state.trending.refresh_count(), before);
}

#[tokio::test]
async fn ttl_limits_refreshes() {
    let t = setup_with(|c| {
        c.trending_ttl = std::time::Duration::from_secs(600);
    })
    .await;
    // Startup refresh.
    assert_eq!(t.state.trending.refresh_count(), 1);
    let (o, _) = t.register("owner").await;
    let g = new_game(&t, &o, "G", "", true).await;
    event(&t, &g, None, 0, Some("u:a")).await;
    t.get("/api/games?sort=trending", None).await;
    t.get(&format!("/api/games/{g}/related"), None).await;
    assert_eq!(t.state.trending.refresh_count(), 1);
    // Within the TTL the snapshot is not recomputed.
    let v = t.get("/api/games?sort=trending", None).await.json();
    assert_eq!(v["items"][0]["playsWeek"], 0);

    // TTL 0: every trending/related read refreshes; other reads never do.
    let t = app().await;
    let n0 = t.state.trending.refresh_count();
    t.get("/api/games", None).await;
    assert_eq!(t.state.trending.refresh_count(), n0);
    t.get("/api/games?sort=trending", None).await;
    t.get("/api/games?sort=trending", None).await;
    assert_eq!(t.state.trending.refresh_count(), n0 + 2);
}
