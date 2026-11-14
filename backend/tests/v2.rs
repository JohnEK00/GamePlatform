//! Integration tests for the v2 API additions (docs/API.md "v2 additions").

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

fn bundle_with_manifest(manifest: &Value) -> Vec<u8> {
    let m = serde_json::to_vec(manifest).unwrap();
    make_zip(&[
        ("game.json", m.as_slice()),
        ("main.js", b"export default {};"),
        ("assets/ach.png", b"\x89PNG\r\n\x1a\nfake"),
        ("assets/other icon.png", b"\x89PNG\r\n\x1a\nfake"),
    ])
}

fn manifest_with(achievements: Value) -> Value {
    json!({ "name": "Ach Game", "entry": "main.js", "width": 320, "height": 240,
            "achievements": achievements })
}

async fn upload(t: &TestApp, tok: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::POST,
        "/api/games",
        Some(tok),
        &[
            Part::Text("title", "Ach"),
            Part::File("bundle", "g.zip", "application/zip", zip),
        ],
    )
    .await
}

async fn replace_bundle(t: &TestApp, tok: &str, id: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(tok),
        &[Part::File("bundle", "g.zip", "application/zip", zip)],
    )
    .await
}

async fn report(t: &TestApp, tok: &str, body: Value) -> Resp {
    t.json(Method::POST, "/api/reports", Some(tok), body).await
}

async fn resolve(t: &TestApp, admin: &str, id: &str, action: &str) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/admin/reports/{id}/resolve"),
        Some(admin),
        json!({ "action": action }),
    )
    .await
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// Roles / admin
// ---------------------------------------------------------------------------

#[tokio::test]
async fn roles_from_admin_usernames() {
    let t = setup_with(|c| c.admin_usernames = vec!["boss".into()]).await;
    let r = t
        .json(
            Method::POST,
            "/api/auth/register",
            None,
            json!({"username": "Boss", "email": "boss@example.com", "password": "password123"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(r.json()["user"]["role"], "admin");
    let boss = r.json()["token"].as_str().unwrap().to_string();
    let (bob, _) = t.register("bob").await;
    assert_eq!(
        t.get("/api/auth/me", Some(&bob)).await.json()["role"],
        "user"
    );

    // Non-admins get 403 on /api/admin/*, anonymous 401.
    let r = t.get("/api/admin/reports", Some(&bob)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.error_code(), "forbidden");
    assert_eq!(
        t.get("/api/admin/reports", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.get("/api/admin/reports", Some(&boss)).await.status,
        StatusCode::OK
    );
    let r = t
        .json(
            Method::POST,
            "/api/admin/reports/nope/resolve",
            Some(&bob),
            json!({"action": "dismiss"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // Startup application: the env list is the source of truth.
    webgame_server::apply_admin_roles(&t.state.db, &["bob".to_string()])
        .await
        .unwrap();
    assert_eq!(
        t.get("/api/auth/me", Some(&bob)).await.json()["role"],
        "admin"
    );
    assert_eq!(
        t.get("/api/auth/me", Some(&boss)).await.json()["role"],
        "user"
    );
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

#[tokio::test]
async fn favorites() {
    let t = setup().await;
    let (a, _) = t.register("fava").await;
    let (b, _) = t.register("favb").await;
    let g1 = t.create_game(&a, "One", "", true).await;
    let g2 = t.create_game(&a, "Two", "", true).await;
    let hidden = t.create_game(&a, "Hidden", "", false).await;
    let (id1, id2) = (g1["id"].as_str().unwrap(), g2["id"].as_str().unwrap());
    assert_eq!(g1["favorites"], 0);
    assert_eq!(g1["isFavorite"], false);

    let fav = |id: &str| format!("/api/games/{id}/favorite");
    let r = t
        .send(Method::PUT, &fav(id1), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json(), json!({"favorited": true, "favorites": 1}));
    // Idempotent.
    let r = t
        .send(Method::PUT, &fav(id1), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.json(), json!({"favorited": true, "favorites": 1}));
    let r = t
        .send(Method::PUT, &fav(id1), Some(&a), None, vec![], &[])
        .await;
    assert_eq!(r.json()["favorites"], 2);
    let r = t
        .send(Method::PUT, &fav(id2), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.json()["favorites"], 1);

    // Anonymous → 401; someone else's unpublished game → 404.
    let r = t
        .send(Method::PUT, &fav(id1), None, None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let hid = hidden["id"].as_str().unwrap();
    let r = t
        .send(Method::PUT, &fav(hid), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Game.isFavorite / GameSummary.favorites.
    let g = t.get(&format!("/api/games/{id1}"), Some(&b)).await.json();
    assert_eq!(g["isFavorite"], true);
    assert_eq!(g["favorites"], 2);
    let g = t.get(&format!("/api/games/{id1}"), None).await.json();
    assert_eq!(g["isFavorite"], false);
    let g = t.get(&format!("/api/games/{hid}"), Some(&a)).await.json();
    assert_eq!(g["isFavorite"], false);

    // sort=favorites
    let l = t.get("/api/games?sort=favorites", None).await.json();
    let titles: Vec<&str> = l["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["One", "Two"]);
    assert_eq!(l["items"][0]["favorites"], 2);

    // My favorites: newest favorite first.
    let r = t.get("/api/users/me/favorites", Some(&b)).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["total"], 2);
    assert_eq!(v["items"][0]["id"], id2);
    assert_eq!(v["items"][1]["id"], id1);
    let v = t
        .get("/api/users/me/favorites?perPage=1&page=2", Some(&b))
        .await
        .json();
    assert_eq!(v["items"][0]["id"], id1);
    assert_eq!(v["perPage"], 1);
    assert_eq!(
        t.get("/api/users/me/favorites", None).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Unfavorite.
    let r = t
        .send(Method::DELETE, &fav(id1), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.json(), json!({"favorited": false, "favorites": 1}));
    let r = t
        .send(Method::DELETE, &fav(id1), Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.json(), json!({"favorited": false, "favorites": 1}));
    let v = t.get("/api/users/me/favorites", Some(&b)).await.json();
    assert_eq!(v["total"], 1);
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

#[tokio::test]
async fn achievements_validation() {
    let t = setup().await;
    let (tok, _) = t.register("achval").await;
    let ok = |id: &str| json!({"id": id, "name": "N"});
    let too_many: Vec<Value> = (0..51).map(|i| ok(&format!("a{i}"))).collect();
    let bad = [
        json!("nope"),
        json!([1]),
        json!([{"name": "No id"}]),
        json!([{"id": "Upper", "name": "x"}]),
        json!([{"id": "has space", "name": "x"}]),
        json!([{"id": "a".repeat(33), "name": "x"}]),
        json!([{"id": "", "name": "x"}]),
        json!([ok("dup"), ok("dup")]),
        json!([{"id": "a"}]),
        json!([{"id": "a", "name": ""}]),
        json!([{"id": "a", "name": "n".repeat(61)}]),
        json!([{"id": "a", "name": "x", "description": "d".repeat(201)}]),
        json!([{"id": "a", "name": "x", "description": 5}]),
        json!([{"id": "a", "name": "x", "icon": "assets/missing.png"}]),
        json!([{"id": "a", "name": "x", "icon": "main.js"}]),
        json!([{"id": "a", "name": "x", "icon": "../x.png"}]),
        json!([{"id": "a", "name": "x", "icon": 3}]),
        Value::Array(too_many),
    ];
    for achievements in bad {
        let zip = bundle_with_manifest(&manifest_with(achievements.clone()));
        let r = upload(&t, &tok, &zip).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{achievements}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation");
    }

    // Exactly 50, max-length fields, and no achievements key at all are fine.
    let fifty: Vec<Value> = (0..50)
        .map(|i| {
            json!({"id": format!("{:_<32}", format!("a-{i}")), "name": "n".repeat(60),
                   "description": "d".repeat(200)})
        })
        .collect();
    let r = upload(
        &t,
        &tok,
        &bundle_with_manifest(&manifest_with(Value::Array(fifty))),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    assert_eq!(r.json()["achievements"].as_array().unwrap().len(), 50);
    let r = upload(&t, &tok, &valid_bundle()).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(r.json()["achievements"], json!([]));
}

#[tokio::test]
async fn achievements_unlock_and_replace() {
    let t = setup().await;
    let (owner, _) = t.register("achowner").await;
    let (p1, _) = t.register("player1").await;
    let (p2, _) = t.register("player2").await;
    let zip = bundle_with_manifest(&manifest_with(json!([
        {"id": "first_blood", "name": " First Blood ", "description": "Destroy one", "icon": "assets/ach.png"},
        {"id": "second", "name": "Second", "icon": "./assets/other icon.png"},
        {"id": "gone", "name": "Gone soon"},
    ])));
    let r = upload(&t, &owner, &zip).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let g = r.json();
    let id = g["id"].as_str().unwrap().to_string();
    assert_eq!(
        g["achievements"][0],
        json!({"id": "first_blood", "name": "First Blood", "description": "Destroy one",
               "iconUrl": format!("/games/{id}/files/assets/ach.png")})
    );
    assert_eq!(
        g["achievements"][1]["iconUrl"],
        format!("/games/{id}/files/assets/other%20icon.png")
    );
    assert_eq!(g["achievements"][1]["description"], "");
    assert!(g["achievements"][2]["iconUrl"].is_null());
    // The icon URL is actually served.
    let icon = t
        .get(&format!("/games/{id}/files/assets/other%20icon.png"), None)
        .await;
    assert_eq!(icon.status, StatusCode::OK);

    let unlock = |ach: &str| format!("/api/games/{id}/achievements/{ach}");
    let r = t
        .send(
            Method::POST,
            &unlock("first_blood"),
            Some(&p1),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["new"], true);
    assert_eq!(v["achievement"]["id"], "first_blood");
    assert_eq!(v["achievement"]["gameId"], id.as_str());
    assert_eq!(v["achievement"]["gameTitle"], "Ach");
    let first_at = v["achievement"]["unlockedAt"].as_str().unwrap().to_string();
    let r = t
        .send(
            Method::POST,
            &unlock("first_blood"),
            Some(&p1),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.json()["new"], false);
    assert_eq!(r.json()["achievement"]["unlockedAt"], first_at.as_str());
    for (tok, ach) in [(&p2, "first_blood"), (&p1, "gone"), (&p1, "second")] {
        let r = t
            .send(Method::POST, &unlock(ach), Some(tok), None, vec![], &[])
            .await;
        assert_eq!(r.json()["new"], true);
    }
    let r = t
        .send(Method::POST, &unlock("nope"), Some(&p1), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .send(
            Method::POST,
            &unlock("first_blood"),
            None,
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Game achievements list.
    let list = t
        .get(&format!("/api/games/{id}/achievements"), Some(&p2))
        .await
        .json();
    assert_eq!(list.as_array().unwrap().len(), 3);
    assert_eq!(list[0]["id"], "first_blood");
    assert_eq!(list[0]["unlockedBy"], 2);
    assert!(list[0]["unlockedAt"].is_string());
    assert_eq!(list[2]["unlockedBy"], 1);
    assert!(list[2]["unlockedAt"].is_null());
    let anon = t
        .get(&format!("/api/games/{id}/achievements"), None)
        .await
        .json();
    assert!(anon[0]["unlockedAt"].is_null());

    // User achievements, most recent first.
    let r = t.get("/api/users/player1/achievements", None).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let ids: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["second", "gone", "first_blood"]);
    let r = t.get("/api/users/player1/achievements?limit=1", None).await;
    assert_eq!(r.json().as_array().unwrap().len(), 1);
    assert_eq!(
        t.get("/api/users/ghost/achievements", None).await.status,
        StatusCode::NOT_FOUND
    );

    // Replace: "gone" removed, "first_blood" kept (renamed), "brand_new" added.
    let zip2 = bundle_with_manifest(&manifest_with(json!([
        {"id": "brand_new", "name": "Brand new"},
        {"id": "first_blood", "name": "Renamed"},
        {"id": "second", "name": "Second"},
    ])));
    let r = replace_bundle(&t, &owner, &id, &zip2).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    let ach: Vec<&str> = v["achievements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ach, vec!["brand_new", "first_blood", "second"]);
    let list = t
        .get(&format!("/api/games/{id}/achievements"), Some(&p1))
        .await
        .json();
    assert_eq!(list[1]["name"], "Renamed");
    assert_eq!(list[1]["unlockedBy"], 2);
    assert_eq!(list[1]["unlockedAt"], first_at.as_str());
    assert_eq!(list[0]["unlockedBy"], 0);
    let mine = t.get("/api/users/player1/achievements", None).await.json();
    assert_eq!(mine.as_array().unwrap().len(), 2);
    let r = t
        .send(Method::POST, &unlock("gone"), Some(&p1), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Invalid replacement keeps the current definitions.
    let bad = bundle_with_manifest(&manifest_with(json!([{"id": "BAD", "name": "x"}])));
    assert_eq!(
        replace_bundle(&t, &owner, &id, &bad).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(g["achievements"].as_array().unwrap().len(), 3);

    // Unpublished game: achievements hidden from others' profiles.
    t.json(
        Method::PATCH,
        &format!("/api/games/{id}"),
        Some(&owner),
        json!({"published": false}),
    )
    .await;
    let mine = t.get("/api/users/player1/achievements", None).await.json();
    assert_eq!(mine.as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// Cloud saves
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cloud_saves() {
    let t = setup().await;
    let (tok, _) = t.register("saver").await;
    let (other, _) = t.register("other").await;
    let g = t.create_game(&tok, "Savegame", "", true).await;
    let url = format!("/api/games/{}/save", g["id"].as_str().unwrap());

    let r = t.get(&url, Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json(), json!({"data": null, "updatedAt": null}));
    assert_eq!(t.get(&url, None).await.status, StatusCode::UNAUTHORIZED);

    let r = t
        .json(
            Method::PUT,
            &url,
            Some(&tok),
            json!({"data": {"level": 3, "items": [1, 2]}}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let updated = r.json()["updatedAt"].as_str().unwrap().to_string();
    let r = t.get(&url, Some(&tok)).await.json();
    assert_eq!(r["data"], json!({"level": 3, "items": [1, 2]}));
    assert_eq!(r["updatedAt"], updated.as_str());
    // Per user.
    assert!(t.get(&url, Some(&other)).await.json()["data"].is_null());

    // Not a plain object → 422.
    for body in [
        json!({"data": [1, 2]}),
        json!({"data": null}),
        json!({"data": "str"}),
        json!({"data": 5}),
        json!({}),
        json!([1]),
    ] {
        let r = t.json(Method::PUT, &url, Some(&tok), body.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(r.error_code(), "validation");
    }

    // > 256KB → 413; exactly at the limit is fine.
    let big = "x".repeat(256 * 1024);
    let r = t
        .json(Method::PUT, &url, Some(&tok), json!({"data": {"s": big}}))
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(r.error_code(), "payload_too_large");
    let fits = "x".repeat(256 * 1024 - r#"{"s":""}"#.len());
    let r = t
        .json(Method::PUT, &url, Some(&tok), json!({"data": {"s": fits}}))
        .await;
    assert_eq!(r.status, StatusCode::OK);

    let r = t
        .send(Method::DELETE, &url, Some(&tok), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(t.get(&url, Some(&tok)).await.json()["data"].is_null());
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stats_zero_filled() {
    let t = setup().await;
    let (tok, uid) = t.register("creator").await;
    let (fan, _) = t.register("fan").await;
    let g1 = t.create_game(&tok, "S1", "", true).await;
    t.create_game(&tok, "S2", "", false).await;
    let id = g1["id"].as_str().unwrap();

    // Empty series.
    let r = t.get("/api/users/me/stats", Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    let daily = v["daily"].as_array().unwrap();
    assert_eq!(daily.len(), 30);
    assert!(daily.iter().all(|d| d["plays"] == 0));
    assert_eq!(daily[29]["date"], today());
    assert_eq!(v["totals"]["ratingAvg"], 0.0);

    // Two plays today (anon + authed), one 5 days ago, one 40 days ago (out of range).
    for who in [None, Some(fan.as_str())] {
        let r = t
            .send(
                Method::POST,
                &format!("/api/games/{id}/play"),
                who,
                None,
                vec![],
                &[],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let users: Vec<(Option<String>,)> =
        sqlx::query_as("SELECT user_id FROM play_events ORDER BY id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(users[0].0, None);
    assert!(users[1].0.is_some());
    let day = |n: i64| {
        (chrono::Utc::now().date_naive() - chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string()
    };
    for n in [5, 40] {
        sqlx::query(
            "INSERT INTO play_events (game_id, user_id, day, created_at) VALUES (?, NULL, ?, ?)",
        )
        .bind(id)
        .bind(day(n))
        .bind("2000-01-01T00:00:00.000Z")
        .execute(&t.state.db)
        .await
        .unwrap();
    }

    // Activity: rating, comment, favorite, score, save.
    t.json(
        Method::PUT,
        &format!("/api/games/{id}/rating"),
        Some(&fan),
        json!({"score": 4}),
    )
    .await;
    t.json(
        Method::PUT,
        &format!("/api/games/{id}/rating"),
        Some(&tok),
        json!({"score": 5}),
    )
    .await;
    t.json(
        Method::POST,
        &format!("/api/games/{id}/comments"),
        Some(&fan),
        json!({"body": "hi"}),
    )
    .await;
    t.send(
        Method::PUT,
        &format!("/api/games/{id}/favorite"),
        Some(&fan),
        None,
        vec![],
        &[],
    )
    .await;
    t.json(
        Method::POST,
        &format!("/api/games/{id}/scores"),
        Some(&fan),
        json!({"score": 10}),
    )
    .await;
    t.json(
        Method::PUT,
        &format!("/api/games/{id}/save"),
        Some(&tok),
        json!({"data": {}}),
    )
    .await;

    let v = t.get("/api/users/me/stats", Some(&tok)).await.json();
    assert_eq!(
        v["totals"],
        json!({"games": 2, "published": 1, "plays": 2, "favorites": 1, "comments": 1,
               "ratingCount": 2, "ratingAvg": 4.5})
    );
    let daily = v["daily"].as_array().unwrap();
    assert_eq!(daily.len(), 30);
    assert_eq!(daily[29], json!({"date": today(), "plays": 2}));
    assert_eq!(daily[24], json!({"date": day(5), "plays": 1}));
    assert_eq!(daily[0]["date"], day(29));
    let sum: i64 = daily.iter().map(|d| d["plays"].as_i64().unwrap()).sum();
    assert_eq!(sum, 3);

    let r = t.get(&format!("/api/games/{id}/stats"), Some(&tok)).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["plays"], 2);
    assert_eq!(v["favorites"], 1);
    assert_eq!(v["comments"], 1);
    assert_eq!(v["uniquePlayers"], 2);
    assert_eq!(v["daily"].as_array().unwrap().len(), 30);
    assert_eq!(v["daily"][29]["plays"], 2);

    // Owner only.
    let r = t.get(&format!("/api/games/{id}/stats"), Some(&fan)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(
        t.get(&format!("/api/games/{id}/stats"), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.get("/api/users/me/stats", None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let _ = uid;
}

// ---------------------------------------------------------------------------
// Reports / moderation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reports_and_moderation() {
    let t = setup_with(|c| c.admin_usernames = vec!["mod".into()]).await;
    let (admin, _) = t.register("mod").await;
    let (owner, _) = t.register("owner").await;
    let (r1, r1_id) = t.register("reporter1").await;
    let (r2, _) = t.register("reporter2").await;
    let g = t.create_game(&owner, "Reported", "", true).await;
    let gid = g["id"].as_str().unwrap().to_string();

    let r = report(
        &t,
        &r1,
        json!({"targetType": "game", "targetId": gid, "reason": "spam", "details": " junk "}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let rep = r.json();
    assert_eq!(rep["targetType"], "game");
    assert_eq!(rep["targetId"], gid.as_str());
    assert_eq!(rep["targetGameId"], gid.as_str());
    assert_eq!(rep["targetPreview"], "Reported");
    assert_eq!(rep["reason"], "spam");
    assert_eq!(rep["details"], "junk");
    assert_eq!(rep["reporter"]["id"], r1_id.as_str());
    assert_eq!(rep["status"], "open");
    assert!(rep["resolution"].is_null());
    assert!(rep["resolvedAt"].is_null());
    let rep1_id = rep["id"].as_str().unwrap().to_string();

    // Same user, same open target → 409.
    let r = report(
        &t,
        &r1,
        json!({"targetType": "game", "targetId": gid, "reason": "other"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    // Validation + missing targets.
    for body in [
        json!({"targetType": "game", "targetId": gid, "reason": "meh"}),
        json!({"targetType": "user", "targetId": gid, "reason": "spam"}),
        json!({"targetType": "game", "targetId": gid, "reason": "spam", "details": "d".repeat(1001)}),
    ] {
        let r = report(&t, &r2, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    let r = report(
        &t,
        &r2,
        json!({"targetType": "game", "targetId": "missing", "reason": "spam"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = report(
        &t,
        &r2,
        json!({"targetType": "comment", "targetId": "missing", "reason": "spam"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .json(
            Method::POST,
            "/api/reports",
            None,
            json!({"targetType": "game", "targetId": gid, "reason": "spam"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    let r = report(
        &t,
        &r2,
        json!({"targetType": "game", "targetId": gid, "reason": "broken"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED);

    // Comment report: preview is the first 140 chars.
    let long = "c".repeat(300);
    let c = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&owner),
            json!({"body": long}),
        )
        .await
        .json();
    let cid = c["id"].as_str().unwrap().to_string();
    let r = report(
        &t,
        &r1,
        json!({"targetType": "comment", "targetId": cid, "reason": "offensive"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let crep = r.json();
    assert_eq!(crep["targetPreview"].as_str().unwrap().len(), 140);
    assert_eq!(crep["targetGameId"], gid.as_str());
    let crep_id = crep["id"].as_str().unwrap().to_string();

    // Admin listing.
    assert_eq!(
        t.get("/api/admin/reports", Some(&r1)).await.status,
        StatusCode::FORBIDDEN
    );
    let v = t
        .get("/api/admin/reports?status=open", Some(&admin))
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["items"][0]["id"], crep_id.as_str());
    let v = t
        .get("/api/admin/reports?status=resolved", Some(&admin))
        .await
        .json();
    assert_eq!(v["total"], 0);
    assert_eq!(
        t.get("/api/admin/reports?status=bogus", Some(&admin))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    // Unpublish is only valid for games; unknown action → 422; unknown report → 404.
    assert_eq!(
        resolve(&t, &admin, &crep_id, "unpublish").await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        resolve(&t, &admin, &crep_id, "explode").await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        resolve(&t, &admin, "nope", "dismiss").await.status,
        StatusCode::NOT_FOUND
    );

    // Delete the comment.
    let r = resolve(&t, &admin, &crep_id, "delete").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["status"], "resolved");
    assert_eq!(r.json()["resolution"], "delete");
    assert!(r.json()["resolvedAt"].is_string());
    let comments = t
        .get(&format!("/api/games/{gid}/comments"), None)
        .await
        .json();
    assert_eq!(comments["total"], 0);
    // Already resolved → 409.
    assert_eq!(
        resolve(&t, &admin, &crep_id, "dismiss").await.status,
        StatusCode::CONFLICT
    );

    // Unpublish the game: resolves both open reports on it.
    let r = resolve(&t, &admin, &rep1_id, "unpublish").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["resolution"], "unpublish");
    let g = t
        .get(&format!("/api/games/{gid}"), Some(&owner))
        .await
        .json();
    assert_eq!(g["published"], false);
    assert_eq!(
        t.get(&format!("/api/games/{gid}"), None).await.status,
        StatusCode::NOT_FOUND
    );
    let v = t
        .get("/api/admin/reports?status=open", Some(&admin))
        .await
        .json();
    assert_eq!(v["total"], 0);
    let v = t
        .get("/api/admin/reports?status=resolved&perPage=2", Some(&admin))
        .await
        .json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    let v = t.get("/api/admin/reports", Some(&admin)).await.json();
    assert!(
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["targetType"] == "game")
            .all(|r| r["resolution"] == "unpublish")
    );

    // Once resolved, the same user may report again; dismiss leaves the game alone;
    // delete removes it.
    t.json(
        Method::PATCH,
        &format!("/api/games/{gid}"),
        Some(&owner),
        json!({"published": true}),
    )
    .await;
    let r = report(
        &t,
        &r1,
        json!({"targetType": "game", "targetId": gid, "reason": "copyright"}),
    )
    .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let id = r.json()["id"].as_str().unwrap().to_string();
    let r = resolve(&t, &admin, &id, "dismiss").await;
    assert_eq!(r.json()["resolution"], "dismiss");
    assert_eq!(
        t.get(&format!("/api/games/{gid}"), None).await.status,
        StatusCode::OK
    );
    let r = report(
        &t,
        &r1,
        json!({"targetType": "game", "targetId": gid, "reason": "copyright"}),
    )
    .await;
    let id = r.json()["id"].as_str().unwrap().to_string();
    let r = resolve(&t, &admin, &id, "delete").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["targetPreview"], "Reported");
    assert_eq!(
        t.get(&format!("/api/games/{gid}"), Some(&owner))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert!(!t.state.storage.game_dir(&gid).exists());
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rate_limits() {
    let t = setup_with(|c| c.rate_limit = true).await;
    // Registrations count against the per-IP auth bucket (10/min).
    let (a, _) = t.register("rla").await;
    let (b, _) = t.register("rlb").await;
    let login = || async {
        t.json(
            Method::POST,
            "/api/auth/login",
            None,
            json!({"login": "nobody", "password": "password123"}),
        )
        .await
    };
    for _ in 0..8 {
        assert_eq!(login().await.status, StatusCode::UNAUTHORIZED);
    }
    let r = login().await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    let retry: u64 = r.header("retry-after").parse().unwrap();
    assert!((1..=6).contains(&retry), "{retry}");

    // Per-user buckets: save PUT 60/min.
    let g = t.create_game(&a, "RL", "", true).await;
    let url = format!("/api/games/{}/save", g["id"].as_str().unwrap());
    for _ in 0..60 {
        let r = t
            .json(Method::PUT, &url, Some(&a), json!({"data": {}}))
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let r = t
        .json(Method::PUT, &url, Some(&a), json!({"data": {}}))
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(!r.header("retry-after").is_empty());
    let r = t
        .json(Method::PUT, &url, Some(&b), json!({"data": {}}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn rate_limit_trust_proxy_uses_forwarded_ip() {
    let t = setup_with(|c| {
        c.rate_limit = true;
        c.trust_proxy = 1;
    })
    .await;
    let t = &t;
    let login = |ip: String| async move {
        t.send(
            Method::POST,
            "/api/auth/login",
            None,
            Some("application/json"),
            br#"{"login":"x","password":"password123"}"#.to_vec(),
            &[("x-forwarded-for", ip.as_str())],
        )
        .await
        .status
    };
    // The rightmost entry (appended by the trusted proxy) is the key; spoofed leftmost
    // values all land in the same bucket.
    for i in 0..10 {
        assert_eq!(
            login(format!("6.6.6.{i}, 10.0.0.1")).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        login("7.7.7.7, 10.0.0.1".into()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login("10.0.0.1".into()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login("10.0.0.1, 10.0.0.2".into()).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rate_limit_trust_proxy_two_hops() {
    let t = setup_with(|c| {
        c.rate_limit = true;
        c.trust_proxy = 2;
    })
    .await;
    let t = &t;
    let login = |ip: String| async move {
        t.send(
            Method::POST,
            "/api/auth/login",
            None,
            Some("application/json"),
            br#"{"login":"x","password":"password123"}"#.to_vec(),
            &[("x-forwarded-for", ip.as_str())],
        )
        .await
        .status
    };
    for i in 0..10 {
        assert_eq!(
            login(format!("6.6.6.{i}, 10.0.0.1, 172.16.0.{i}")).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        login("1.2.3.4, 10.0.0.1, 172.16.0.9".into()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        login("10.0.0.1, 10.0.0.2, 172.16.0.1".into()).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rate_limit_429_exposes_retry_after_to_cors() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let mut last = None;
    for _ in 0..11 {
        last = Some(
            t.send(
                Method::POST,
                "/api/auth/login",
                None,
                Some("application/json"),
                br#"{"login":"x","password":"password123"}"#.to_vec(),
                &[("origin", "http://localhost:5173")],
            )
            .await,
        );
    }
    let r = last.unwrap();
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(!r.header("retry-after").is_empty());
    assert_eq!(
        r.header("access-control-allow-origin"),
        "http://localhost:5173"
    );
    // F013 exposes more headers (X-Game-Version, Content-Disposition) next to Retry-After.
    assert!(
        r.header("access-control-expose-headers")
            .to_ascii_lowercase()
            .split(',')
            .any(|h| h.trim() == "retry-after")
    );
}

#[tokio::test]
async fn rate_limit_ignores_forwarded_for_without_trust_proxy() {
    let t = setup_with(|c| c.rate_limit = true).await;
    for i in 0..11 {
        let ip = format!("10.0.0.{i}");
        let r = t
            .send(
                Method::POST,
                "/api/auth/login",
                None,
                Some("application/json"),
                br#"{"login":"x","password":"password123"}"#.to_vec(),
                &[("x-forwarded-for", ip.as_str())],
            )
            .await;
        let want = if i < 10 {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::TOO_MANY_REQUESTS
        };
        assert_eq!(r.status, want);
    }
}

// ---------------------------------------------------------------------------
// Studio player
// ---------------------------------------------------------------------------

#[tokio::test]
async fn studio_player_page() {
    let t = setup().await;
    let r = t.get("/play/studio", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert!(r.header("content-type").starts_with("text/html"));
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    let csp = r.header("content-security-policy");
    assert!(
        csp.starts_with("sandbox allow-scripts allow-pointer-lock;"),
        "{csp}"
    );
    assert!(csp.contains("script-src http://localhost:8080 'unsafe-inline' 'unsafe-eval' blob:"));
    assert!(csp.contains("img-src http://localhost:8080 data: blob:"));
    assert!(csp.contains("media-src http://localhost:8080 data: blob:"));
    assert!(csp.contains("connect-src http://localhost:8080 data: blob:"));
    let html = r.text();
    for needle in [
        r#"import("http://localhost:8080/runtime/engine.js")"#,
        r#"post({ type: "webgame:studio-ready" })"#,
        r#"d.type !== "webgame:studio-load""#,
        "event.source !== window.parent",
        r#"new Blob([src], { type: "text/javascript" })"#,
        "URL.createObjectURL",
        r#"baseUrl: "about:blank", files"#,
        r#"type: "webgame:error""#,
        "msg.line = line",
        "msg.column = column",
        r#"<canvas id="game">"#,
    ] {
        assert!(html.contains(needle), "missing {needle}");
    }
    // boot() posts its own webgame:error before rethrowing; the page must not post a second one.
    let boot_catch = &html[html.find("await boot(").unwrap()..];
    let boot_catch = &boot_catch[..boot_catch.find("});\n    post(").unwrap()];
    assert!(!boot_catch.contains("reportError"), "{boot_catch}");
    assert!(html.contains(r#"reportError("Failed to load " + entry"#));
    // The ready message is posted only after the message listener is installed.
    assert!(
        html.find("addEventListener(\"message\"").unwrap()
            < html.find("webgame:studio-ready").unwrap()
    );

    // PUBLIC_ORIGIN wins over Host.
    let t = setup_with(|c| c.public_origin = Some("https://arcade.example.com".into())).await;
    let r = t
        .send(
            Method::GET,
            "/play/studio",
            None,
            None,
            vec![],
            &[("host", "evil.test")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(
        r.text()
            .contains("https://arcade.example.com/runtime/engine.js")
    );
    assert!(!r.text().contains("evil.test"));
    assert!(
        r.header("content-security-policy")
            .contains("script-src https://arcade.example.com")
    );
}
