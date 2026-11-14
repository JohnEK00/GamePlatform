//! F004: version changelogs and the "Updated" badge (docs/API.md § F004 additions).

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};

fn dir_names(p: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(p)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn bundle_with(main_js: &str, filler: usize) -> Vec<u8> {
    let pad = vec![b'x'; filler];
    make_zip(&[
        ("game.json", GAME_JSON.as_bytes()),
        ("main.js", main_js.as_bytes()),
        ("assets/pad.txt", &pad),
    ])
}

async fn replace_with(
    t: &TestApp,
    tok: &str,
    id: &str,
    zip: &[u8],
    notes: Option<&str>,
    expected: Option<&str>,
) -> Resp {
    let mut parts = Vec::new();
    if let Some(n) = notes {
        parts.push(Part::Text("notes", n));
    }
    if let Some(e) = expected {
        parts.push(Part::Text("expectedVersion", e));
    }
    parts.push(Part::File("bundle", "game.zip", "application/zip", zip));
    t.multipart(
        Method::PUT,
        &format!("/api/games/{id}/bundle"),
        Some(tok),
        &parts,
    )
    .await
}

/// Replace with notes; asserts 200 and returns the Game.
async fn replace_ok(t: &TestApp, tok: &str, id: &str, notes: &str) -> Value {
    let r = replace_with(t, tok, id, &valid_bundle(), Some(notes), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()
}

async fn create_with_notes(t: &TestApp, tok: &str, notes: &str, published: bool) -> Resp {
    let zip = valid_bundle();
    t.multipart(
        Method::POST,
        "/api/games",
        Some(tok),
        &[
            Part::Text("title", "Noted"),
            Part::Text("published", if published { "true" } else { "false" }),
            Part::Text("notes", notes),
            Part::File("bundle", "game.zip", "application/zip", &zip),
        ],
    )
    .await
}

async fn game_id(t: &TestApp, tok: &str, published: bool) -> String {
    let g = t.create_game(tok, "Game", "", published).await;
    g["id"].as_str().unwrap().to_string()
}

async fn versions(t: &TestApp, id: &str, tok: Option<&str>, query: &str) -> Resp {
    t.get(&format!("/api/games/{id}/versions{query}"), tok)
        .await
}

async fn patch_notes(t: &TestApp, tok: Option<&str>, id: &str, version: &str, body: Value) -> Resp {
    t.json(
        Method::PATCH,
        &format!("/api/games/{id}/versions/{version}"),
        tok,
        body,
    )
    .await
}

async fn version_rows(t: &TestApp, id: &str) -> Vec<(i64, String)> {
    sqlx::query_as("SELECT version, notes FROM game_versions WHERE game_id = ? ORDER BY version")
        .bind(id)
        .fetch_all(&t.state.db)
        .await
        .unwrap()
}

async fn updated_events(t: &TestApp, id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM activity_events WHERE game_id = ? AND kind = 'gameUpdated'",
    )
    .bind(id)
    .fetch_one(&t.state.db)
    .await
    .unwrap()
}

async fn follow_ok(t: &TestApp, tok: &str, username: &str) {
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

async fn feed(t: &TestApp, tok: &str) -> Vec<Value> {
    let r = t.get("/api/feed?limit=50", Some(tok)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    r.json()["items"].as_array().unwrap().clone()
}

fn feed_item<'a>(items: &'a [Value], game: &str, kind: &str) -> &'a Value {
    items
        .iter()
        .find(|i| i["game"]["id"] == game && i["kind"] == kind)
        .unwrap_or_else(|| panic!("no {kind} item for {game}: {items:?}"))
}

fn changes(item: &Value) -> Vec<(i64, String)> {
    item["update"]["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["version"].as_i64().unwrap(),
                c["notes"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Create + replace
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_with_notes_writes_v1_row() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let r = create_with_notes(&t, &tok, "  First release!  ", true).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let g = r.json();
    let id = g["id"].as_str().unwrap();
    assert_eq!(g["latestVersion"]["version"], 1);
    assert_eq!(g["latestVersion"]["notes"], "First release!");
    assert_eq!(g["latestVersion"]["current"], true);
    assert_eq!(g["latestVersion"]["createdAt"], g["createdAt"]);
    assert!(g["lastUpdatedAt"].is_null());

    let v = versions(&t, id, None, "").await;
    assert_eq!(v.status, StatusCode::OK);
    let v = v.json();
    assert_eq!(v["total"], 1);
    assert_eq!(v["perPage"], 20);
    assert_eq!(v["items"][0]["version"], 1);
    assert_eq!(v["items"][0]["current"], true);
    assert_eq!(v["items"][0]["notes"], "First release!");

    // Listings carry lastUpdatedAt too.
    let list = t.get("/api/games", None).await.json();
    assert!(list["items"][0].get("lastUpdatedAt").unwrap().is_null());

    // Without a notes field: empty note.
    let g2 = t.create_game(&tok, "Plain", "", true).await;
    assert_eq!(g2["latestVersion"]["notes"], "");

    // Invalid notes on create → 422, nothing created.
    let r = create_with_notes(&t, &tok, "bad\u{202E}", true).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

#[tokio::test]
async fn replace_with_notes_history_and_paging() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let id = game_id(&t, &tok, true).await;

    let g = replace_ok(&t, &tok, &id, "Added 3 new levels").await;
    assert_eq!(g["version"], 2);
    assert_eq!(g["latestVersion"]["version"], 2);
    assert_eq!(g["latestVersion"]["notes"], "Added 3 new levels");
    assert_eq!(g["latestVersion"]["current"], true);
    assert!(g["lastUpdatedAt"].is_string());
    assert_eq!(g["lastUpdatedAt"], g["latestVersion"]["createdAt"]);
    assert_eq!(g["updatedAt"], g["latestVersion"]["createdAt"]);

    let g = replace_ok(&t, &tok, &id, "").await;
    assert_eq!(g["version"], 3);
    assert_eq!(g["latestVersion"]["notes"], "");

    let v = versions(&t, &id, None, "").await.json();
    assert_eq!(v["total"], 3);
    let vs: Vec<(i64, bool)> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["version"].as_i64().unwrap(),
                i["current"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(vs, vec![(3, true), (2, false), (1, false)]);
    assert_eq!(v["items"][1]["notes"], "Added 3 new levels");

    let p = versions(&t, &id, None, "?perPage=2&page=2").await.json();
    assert_eq!(p["total"], 3);
    assert_eq!(p["page"], 2);
    assert_eq!(p["perPage"], 2);
    assert_eq!(p["items"].as_array().unwrap().len(), 1);
    assert_eq!(p["items"][0]["version"], 1);
    assert_eq!(
        versions(&t, &id, None, "?page=x").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn notes_validation() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let id = game_id(&t, &tok, true).await;
    let mut version = 1;

    let ok = |notes: String, want: &'static str| (notes, Some(want));
    let cases: Vec<(String, Option<&str>)> = vec![
        ok("a\r\nb\rc".into(), "a\nb\nc"),
        ok("   \n  trimmed \t\n\n".into(), "trimmed"),
        ok("a\n\n\n\n\nb".into(), "a\n\n\nb"),
        ok("tab\there".into(), "tab\there"),
        ("x".repeat(1001), None),
        ("a\0b".into(), None),
        ("a\u{202E}b".into(), None),
        ("a\u{2068}b".into(), None),
        ("a\u{1b}[31m".into(), None),
    ];
    for (notes, want) in cases {
        let r = replace_with(&t, &tok, &id, &valid_bundle(), Some(&notes), None).await;
        match want {
            Some(w) => {
                assert_eq!(r.status, StatusCode::OK, "{notes:?}: {}", r.text());
                version += 1;
                assert_eq!(r.json()["latestVersion"]["notes"], w, "{notes:?}");
            }
            None => {
                assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{notes:?}");
                assert_eq!(r.error_code(), "validation");
            }
        }
    }
    // 1000 chars (multi-byte) is fine; 1001 is not, with the documented message.
    let g = replace_ok(&t, &tok, &id, &"é".repeat(1000)).await;
    version += 1;
    assert_eq!(
        g["latestVersion"]["notes"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        1000
    );
    let r = replace_with(
        &t,
        &tok,
        &id,
        &valid_bundle(),
        Some(&"x".repeat(1001)),
        None,
    )
    .await;
    assert!(r.text().contains("notes must be at most 1000 characters"));
    let r = replace_with(&t, &tok, &id, &valid_bundle(), Some("a\0"), None).await;
    assert!(r.text().contains("notes contain invalid characters"));
    // > 8 KB raw → 422 even if it would trim down.
    let big = format!("{}a", " ".repeat(9000));
    let r = replace_with(&t, &tok, &id, &valid_bundle(), Some(&big), None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Missing field → "".
    let r = replace_with(&t, &tok, &id, &valid_bundle(), None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    version += 1;
    assert_eq!(r.json()["latestVersion"]["notes"], "");

    // Rejected replaces wrote nothing.
    let rows = version_rows(&t, &id).await;
    assert_eq!(rows.len() as i64, version);
    assert_eq!(rows.last().unwrap().0, version);
    assert_eq!(
        dir_names(&t.state.storage.game_dir(&id)),
        vec![format!("v{version}")]
    );

    // The PATCH endpoint applies the same rules.
    let r = patch_notes(&t, Some(&tok), &id, "1", json!({ "notes": "x\r\ny  " })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["notes"], "x\ny");
    let r = patch_notes(
        &t,
        Some(&tok),
        &id,
        "1",
        json!({ "notes": "x".repeat(1001) }),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = patch_notes(&t, Some(&tok), &id, "1", json!({ "notes": "\u{202A}" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

// ---------------------------------------------------------------------------
// expectedVersion + R1
// ---------------------------------------------------------------------------

#[tokio::test]
async fn expected_version_checks() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let id = game_id(&t, &tok, true).await;
    let gd = t.state.storage.game_dir(&id);

    // Equal → 200.
    let r = replace_with(&t, &tok, &id, &valid_bundle(), Some("v2"), Some("1")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["version"], 2);
    assert_eq!(updated_events(&t, &id).await, 1);
    let before_rows = version_rows(&t, &id).await;
    let main_js = std::fs::read(gd.join("v2").join("main.js")).unwrap();

    // Stale → 409, nothing written.
    let other = bundle_with("export default { other: 1 };", 0);
    let r = replace_with(&t, &tok, &id, &other, Some("stale"), Some("1")).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.error_code(), "conflict");
    assert!(
        r.text().contains("The game is at v2; reload and retry"),
        "{}",
        r.text()
    );
    assert_eq!(version_rows(&t, &id).await, before_rows);
    assert_eq!(dir_names(&gd), vec!["v2".to_string()]);
    assert_eq!(
        std::fs::read(gd.join("v2").join("main.js")).unwrap(),
        main_js
    );
    assert_eq!(updated_events(&t, &id).await, 1);
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(g["version"], 2);
    // A future version is also a mismatch.
    let r = replace_with(&t, &tok, &id, &valid_bundle(), None, Some("3")).await;
    assert_eq!(r.status, StatusCode::CONFLICT);

    // Not a positive integer → 400 before extraction (an invalid bundle would be 422).
    let bad_zip = make_zip(&[("readme.txt", b"no manifest")]);
    for ev in ["abc", "0", "-1", "1.0", ""] {
        let r = replace_with(&t, &tok, &id, &bad_zip, None, Some(ev)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{ev:?}: {}", r.text());
        assert_eq!(r.error_code(), "bad_request");
        assert!(
            r.text()
                .contains("expectedVersion must be a positive integer")
        );
    }
    // Field order is free: expectedVersion after the bundle.
    let zip = valid_bundle();
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{id}/bundle"),
            Some(&tok),
            &[
                Part::File("bundle", "game.zip", "application/zip", &zip),
                Part::Text("expectedVersion", "2"),
                Part::Text("notes", "after"),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["latestVersion"]["notes"], "after");

    // Absent → v1 behaviour.
    let r = replace_with(&t, &tok, &id, &valid_bundle(), None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["version"], 4);
    assert_eq!(dir_names(&gd), vec!["v4".to_string()]);
}

#[tokio::test]
async fn r1_race_writes_one_version_row() {
    let t = setup().await;
    let (tok, _) = t.register("racer").await;
    let id = game_id(&t, &tok, true).await;

    let za = bundle_with("export default { a: 1 };", 4 << 20);
    let zb = bundle_with("export default { b: 2 };", 4 << 20);
    let (ra, rb) = tokio::join!(
        replace_with(&t, &tok, &id, &za, Some("from a"), Some("1")),
        replace_with(&t, &tok, &id, &zb, Some("from b"), None)
    );
    let mut statuses = [ra.status.as_u16(), rb.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{} / {}", ra.text(), rb.text());
    let winner = if ra.status == StatusCode::OK {
        &ra
    } else {
        &rb
    };
    let rows = version_rows(&t, &id).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].0, 2);
    assert_eq!(
        Value::String(rows[1].1.clone()),
        winner.json()["latestVersion"]["notes"]
    );
    assert_eq!(updated_events(&t, &id).await, 1);
    assert_eq!(
        dir_names(&t.state.storage.game_dir(&id)),
        vec!["v2".to_string()]
    );
}

// ---------------------------------------------------------------------------
// lastUpdatedAt rules
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unpublished_replace_and_publish_do_not_badge() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let id = game_id(&t, &tok, false).await;

    let g = replace_ok(&t, &tok, &id, "draft change").await;
    assert_eq!(g["version"], 2);
    assert_eq!(g["latestVersion"]["notes"], "draft change");
    assert!(g["lastUpdatedAt"].is_null());
    assert_eq!(version_rows(&t, &id).await.len(), 2);
    assert_eq!(updated_events(&t, &id).await, 0);

    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{id}"),
            Some(&tok),
            json!({ "published": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["lastUpdatedAt"].is_null());
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert!(g["lastUpdatedAt"].is_null());
    assert_eq!(updated_events(&t, &id).await, 0);
}

#[tokio::test]
async fn metadata_patch_keeps_last_updated_at() {
    let t = setup().await;
    let (tok, _) = t.register("ana").await;
    let id = game_id(&t, &tok, true).await;
    let g = replace_ok(&t, &tok, &id, "n").await;
    let lu = g["lastUpdatedAt"].clone();
    assert!(lu.is_string());
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{id}"),
            Some(&tok),
            json!({ "title": "Renamed" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let g = r.json();
    assert_eq!(g["title"], "Renamed");
    assert_eq!(g["lastUpdatedAt"], lu);
    // Unpublish + republish also keeps it.
    for p in [false, true] {
        t.json(
            Method::PATCH,
            &format!("/api/games/{id}"),
            Some(&tok),
            json!({ "published": p }),
        )
        .await;
    }
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(g["lastUpdatedAt"], lu);
}

// ---------------------------------------------------------------------------
// PATCH …/versions/{v} + visibility
// ---------------------------------------------------------------------------

#[tokio::test]
async fn edit_version_notes() {
    let t = setup().await;
    let (owner, _) = t.register("ana").await;
    let (other, _) = t.register("bob").await;
    follow_ok(&t, &other, "ana").await;
    let id = game_id(&t, &owner, true).await;
    let g = replace_ok(&t, &owner, &id, "Faster asteroids").await;
    let lu = g["lastUpdatedAt"].clone();
    let updated_at = g["updatedAt"].clone();
    let events_before: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, created_at FROM activity_events ORDER BY id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();

    let r = patch_notes(
        &t,
        Some(&owner),
        &id,
        "2",
        json!({ "notes": "Faster asteroids and a new ship" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["version"], 2);
    assert_eq!(v["notes"], "Faster asteroids and a new ship");
    assert_eq!(v["current"], true);
    assert_eq!(v["createdAt"], g["latestVersion"]["createdAt"]);

    let g2 = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(
        g2["latestVersion"]["notes"],
        "Faster asteroids and a new ship"
    );
    assert_eq!(g2["lastUpdatedAt"], lu);
    assert_eq!(g2["updatedAt"], updated_at);
    let events_after: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, created_at FROM activity_events ORDER BY id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(events_before, events_after);
    let items = feed(&t, &other).await;
    let item = feed_item(&items, &id, "gameUpdated");
    assert_eq!(
        changes(item),
        vec![(2, "Faster asteroids and a new ship".to_string())]
    );

    // A non-current version.
    let r = patch_notes(&t, Some(&owner), &id, "1", json!({ "notes": "old" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["current"], false);

    // Errors.
    let body = json!({ "notes": "x" });
    assert_eq!(
        patch_notes(&t, None, &id, "2", body.clone()).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        patch_notes(&t, Some(&other), &id, "2", body.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let r = patch_notes(&t, Some(&owner), &id, "9", body.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
    for bad in ["abc", "0", "-2"] {
        let r = patch_notes(&t, Some(&owner), &id, bad, body.clone()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(
        patch_notes(&t, Some(&owner), "nope", "1", body.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    for b in [json!({}), json!({ "notes": 5 }), json!({ "notes": null })] {
        let r = patch_notes(&t, Some(&owner), &id, "2", b).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(r.error_code(), "validation");
    }

    // Unpublished: others get 404.
    let hidden = game_id(&t, &owner, false).await;
    assert_eq!(
        patch_notes(&t, Some(&other), &hidden, "1", body.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn edit_version_notes_rate_limited() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("ana").await;
    let id = game_id(&t, &owner, true).await;
    for i in 0..30 {
        let r = patch_notes(
            &t,
            Some(&owner),
            &id,
            "1",
            json!({ "notes": format!("n{i}") }),
        )
        .await;
        assert_eq!(r.status, StatusCode::OK, "{i}: {}", r.text());
    }
    let r = patch_notes(&t, Some(&owner), &id, "1", json!({ "notes": "late" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());
    // Reads stay unlimited.
    for _ in 0..40 {
        assert_eq!(versions(&t, &id, None, "").await.status, StatusCode::OK);
    }
}

#[tokio::test]
async fn versions_visibility() {
    let t = setup().await;
    let (owner, _) = t.register("ana").await;
    let (other, _) = t.register("bob").await;
    let hidden = game_id(&t, &owner, false).await;
    assert_eq!(
        versions(&t, &hidden, None, "").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        versions(&t, &hidden, Some(&other), "").await.status,
        StatusCode::NOT_FOUND
    );
    let r = versions(&t, &hidden, Some(&owner), "").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["total"], 1);
    assert_eq!(
        versions(&t, "nope", None, "").await.status,
        StatusCode::NOT_FOUND
    );
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn feed_update_from_version_and_changes() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let (b, _) = t.register("bob").await;
    follow_ok(&t, &b, "ana").await;

    // Two replaces within 24h → one item covering v2..v3, both notes newest first.
    let g1 = game_id(&t, &a, true).await;
    replace_ok(&t, &a, &g1, "Faster asteroids").await;
    replace_ok(&t, &a, &g1, "Fixed the pause bug").await;

    // Four replaces, one without notes → at most 3 non-empty changes.
    let g2 = game_id(&t, &a, true).await;
    for n in ["one", "", "three", "four", "five"] {
        replace_ok(&t, &a, &g2, n).await;
    }

    // A single replace.
    let g3 = game_id(&t, &a, true).await;
    replace_ok(&t, &a, &g3, "solo").await;

    // A single replace without notes.
    let g4 = game_id(&t, &a, true).await;
    replace_ok(&t, &a, &g4, "").await;

    let items = feed(&t, &b).await;
    let updated: Vec<&Value> = items
        .iter()
        .filter(|i| i["kind"] == "gameUpdated")
        .collect();
    assert_eq!(updated.len(), 4);

    let i1 = feed_item(&items, &g1, "gameUpdated");
    assert_eq!(i1["version"], 3);
    assert_eq!(i1["update"]["fromVersion"], 2);
    assert_eq!(
        changes(i1),
        vec![
            (3, "Fixed the pause bug".to_string()),
            (2, "Faster asteroids".to_string())
        ]
    );
    assert!(i1["game"]["lastUpdatedAt"].is_string());

    let i2 = feed_item(&items, &g2, "gameUpdated");
    assert_eq!(i2["version"], 6);
    assert_eq!(i2["update"]["fromVersion"], 2);
    assert_eq!(
        changes(i2),
        vec![
            (6, "five".to_string()),
            (5, "four".to_string()),
            (4, "three".to_string())
        ]
    );

    let i3 = feed_item(&items, &g3, "gameUpdated");
    assert_eq!(i3["update"]["fromVersion"], i3["version"]);
    assert_eq!(changes(i3), vec![(2, "solo".to_string())]);

    let i4 = feed_item(&items, &g4, "gameUpdated");
    assert_eq!(i4["update"]["fromVersion"], 2);
    assert!(changes(i4).is_empty());

    // Other kinds → update: null (present in the JSON).
    for i in items.iter().filter(|i| i["kind"] != "gameUpdated") {
        assert!(i.get("update").unwrap().is_null(), "{i}");
    }
    assert!(items.iter().any(|i| i["kind"] == "gamePublished"));

    // Pre-F004 events (from_version NULL) report fromVersion == version, and only that
    // version's notes.
    sqlx::query("UPDATE activity_events SET from_version = NULL WHERE game_id = ?")
        .bind(&g1)
        .execute(&t.state.db)
        .await
        .unwrap();
    let items = feed(&t, &b).await;
    let i1 = feed_item(&items, &g1, "gameUpdated");
    assert_eq!(i1["update"]["fromVersion"], 3);
    assert_eq!(changes(i1), vec![(3, "Fixed the pause bug".to_string())]);

    // A coalesce onto a backfilled row starts from that row's version.
    replace_ok(&t, &a, &g1, "v4 notes").await;
    let items = feed(&t, &b).await;
    let i1 = feed_item(&items, &g1, "gameUpdated");
    assert_eq!(i1["version"], 4);
    assert_eq!(i1["update"]["fromVersion"], 3);
}

// ---------------------------------------------------------------------------
// Migration + cascade
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_backfill_sql() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let g1 = game_id(&t, &a, true).await;
    let g2 = game_id(&t, &a, true).await;
    let g3 = game_id(&t, &a, false).await;
    replace_ok(&t, &a, &g2, "x").await;
    replace_ok(&t, &a, &g3, "draft").await; // unpublished: no event, no last_updated_at

    // Simulate a pre-F004 DB.
    sqlx::query("DELETE FROM game_versions")
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE games SET last_updated_at = NULL")
        .execute(&t.state.db)
        .await
        .unwrap();
    let sql = include_str!("../migrations/0007_f004.sql");
    let backfill = &sql[sql.find("-- Backfill last_updated_at").unwrap()..];
    sqlx::raw_sql(backfill).execute(&t.state.db).await.unwrap();

    let rows: Vec<(String, i64, String, String)> = sqlx::query_as(
        "SELECT v.game_id, v.version, v.notes, v.created_at FROM game_versions v ORDER BY v.game_id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3, "exactly one row per game");
    for (gid, version, notes, created_at) in &rows {
        let (cur, created, updated, lu): (i64, String, String, Option<String>) = sqlx::query_as(
            "SELECT version, created_at, updated_at, last_updated_at FROM games WHERE id = ?",
        )
        .bind(gid)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        assert_eq!(*version, cur);
        assert_eq!(notes, "");
        if gid == &g1 {
            assert_eq!(*created_at, created);
            assert!(lu.is_none());
        } else if gid == &g2 {
            let ev: String = sqlx::query_scalar(
                "SELECT MAX(created_at) FROM activity_events WHERE game_id = ? AND kind = 'gameUpdated'",
            )
            .bind(gid)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
            assert_eq!(lu.as_deref(), Some(ev.as_str()));
            assert_eq!(*created_at, ev);
        } else {
            assert_eq!(gid, &g3);
            assert!(lu.is_none());
            assert_eq!(*created_at, updated);
        }
    }
}

#[tokio::test]
async fn delete_game_cascades_versions() {
    let t = setup().await;
    let (a, _) = t.register("ana").await;
    let id = game_id(&t, &a, true).await;
    replace_ok(&t, &a, &id, "x").await;
    assert_eq!(version_rows(&t, &id).await.len(), 2);
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{id}"),
            Some(&a),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(version_rows(&t, &id).await.is_empty());
}
