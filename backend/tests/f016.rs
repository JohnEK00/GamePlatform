//! F016: synced control bindings (docs/API.md § F016 additions,
//! docs/ARCHITECTURE.md § F016 additions).

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};
use webgame_server::models::ControlAction;
use webgame_server::routes::controls::{RawBindings, normalize_bindings, validate_bindings};

const MAIN_JS: &[u8] = b"export default { update() {}, render() {} };";

/// Default actions, deliberately not in alphabetical order (manifest order: left, jump, fire).
fn default_actions() -> Value {
    json!([
        { "id": "left", "name": "Left", "keys": ["ArrowLeft"], "gamepad": ["Left"] },
        { "id": "jump", "name": "Jump", "keys": ["Space", "ArrowUp"], "gamepad": ["A"] },
        { "id": "fire", "name": "Fire", "keys": ["KeyX"], "gamepad": ["X"] },
    ])
}

fn bundle(actions: Value) -> Vec<u8> {
    let manifest = json!({
        "name": "Ctl", "entry": "main.js", "width": 320, "height": 240, "actions": actions,
    });
    let gj = serde_json::to_vec(&manifest).unwrap();
    make_zip(&[("game.json", &gj), ("main.js", MAIN_JS)])
}

/// Upload a game with `actions`; returns its id.
async fn upload(t: &TestApp, tok: &str, actions: Value, published: bool) -> String {
    let zip = bundle(actions);
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(tok),
            &[
                Part::Text("published", if published { "true" } else { "false" }),
                Part::File("bundle", "game.zip", "application/zip", &zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

async fn replace(t: &TestApp, tok: &str, id: &str, actions: Value) {
    let zip = bundle(actions);
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{id}/bundle"),
            Some(tok),
            &[Part::File("bundle", "game.zip", "application/zip", &zip)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

fn url(id: &str) -> String {
    format!("/api/games/{id}/controls")
}

async fn get_controls(t: &TestApp, tok: Option<&str>, id: &str) -> Resp {
    t.get(&url(id), tok).await
}

async fn put_controls(t: &TestApp, tok: Option<&str>, id: &str, body: Value) -> Resp {
    t.json(Method::PUT, &url(id), tok, body).await
}

/// Owner + published game with the default actions.
async fn world() -> (TestApp, String, String) {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let id = upload(&t, &owner, default_actions(), true).await;
    (t, owner, id)
}

async fn row_count(t: &TestApp, game_id: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM control_bindings WHERE game_id = ?")
        .bind(game_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    n
}

// ---------------------------------------------------------------- auth and visibility

#[tokio::test]
async fn anonymous_is_401() {
    let (t, _, id) = world().await;
    let r = get_controls(&t, None, &id).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.error_code(), "unauthorized");
    let r = put_controls(&t, None, &id, json!({ "bindings": {} })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(row_count(&t, &id).await, 0);
}

#[tokio::test]
async fn visibility_follows_cloud_save_rule() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (other, _) = t.register("other").await;
    let hidden = upload(&t, &owner, default_actions(), false).await;
    let body = json!({ "bindings": { "gamepad": { "jump": ["B"] } } });

    // Unpublished: non-owner → 404 for both methods; nothing stored.
    let r = get_controls(&t, Some(&other), &hidden).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
    let r = put_controls(&t, Some(&other), &hidden, body.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(row_count(&t, &hidden).await, 0);

    // Owner → 200.
    let r = put_controls(&t, Some(&owner), &hidden, body.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let r = get_controls(&t, Some(&owner), &hidden).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["bindings"]["gamepad"], json!({ "jump": ["B"] }));

    // Unknown id → 404.
    let r = get_controls(&t, Some(&owner), "no-such-game").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = put_controls(&t, Some(&owner), "no-such-game", body).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------- GET / PUT and normalisation

#[tokio::test]
async fn get_without_row_is_null() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json(), json!({ "bindings": null, "updatedAt": null }));
}

#[tokio::test]
async fn put_normalises_and_get_returns_the_same() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": {
            "keys": {
                "zzz": ["KeyQ"],                // unknown id → dropped
                "fire": ["KeyX"],               // equal to the defaults → dropped
                "jump": ["KeyK", "Space"],      // kept
                "left": ["KeyA", "Mouse0"],     // kept; Mouse0 is bindable
            },
            "gamepad": {
                "jump": ["B"],
                "left": ["Left"],               // equal to the defaults → dropped
                "fire": [],                     // [] = no buttons; kept
                "nope": ["A"],
            },
            "extra": 1,                         // unknown field → ignored
        } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let expected_text = r#"{"keys":{"left":["KeyA","Mouse0"],"jump":["KeyK","Space"]},"gamepad":{"jump":["B"],"fire":[]}}"#;
    // Manifest order in the response body (not alphabetical).
    assert!(
        r.text().contains(&format!(r#""bindings":{expected_text}"#)),
        "{}",
        r.text()
    );
    let put = r.json();
    let updated_at = put["updatedAt"].as_str().unwrap().to_string();
    chrono::DateTime::parse_from_rfc3339(&updated_at).expect("updatedAt is RFC3339");

    // Stored as compact JSON in manifest order.
    let (stored,): (String,) = sqlx::query_as("SELECT bindings FROM control_bindings")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stored, expected_text);

    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text().contains(expected_text), "{}", r.text());
    assert_eq!(r.json()["bindings"], put["bindings"]);
    assert_eq!(r.json()["updatedAt"], updated_at.as_str());

    // A second PUT replaces the row (one row per user per game).
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": { "gamepad": { "fire": ["Y"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json()["bindings"],
        json!({ "keys": {}, "gamepad": { "fire": ["Y"] } })
    );
    assert_eq!(row_count(&t, &id).await, 1);
}

#[tokio::test]
async fn absent_or_null_sections_are_stored_as_empty_objects() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    for body in [
        json!({ "bindings": {} }),
        json!({ "bindings": { "keys": null, "gamepad": null } }),
        // Everything normalises away (defaults / unknown ids).
        json!({ "bindings": { "keys": { "jump": ["Space", "ArrowUp"], "ghost": [] } } }),
    ] {
        let r = put_controls(&t, Some(&p), &id, body.clone()).await;
        assert_eq!(r.status, StatusCode::OK, "{body}: {}", r.text());
        assert_eq!(r.json()["bindings"], json!({ "keys": {}, "gamepad": {} }));
        let r = get_controls(&t, Some(&p), &id).await;
        let v = r.json();
        assert_eq!(
            v["bindings"],
            json!({ "keys": {}, "gamepad": {} }),
            "{body}"
        );
        assert!(v["updatedAt"].is_string());
    }
    assert_eq!(row_count(&t, &id).await, 1);
}

#[tokio::test]
async fn mouse_codes_are_accepted_in_keys() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": { "keys": { "fire": ["Mouse0", "Mouse1", "Mouse2"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json()["bindings"]["keys"],
        json!({ "fire": ["Mouse0", "Mouse1", "Mouse2"] })
    );
}

#[tokio::test]
async fn unparsable_stored_row_reads_as_no_row() {
    let (t, _, id) = world().await;
    let (p, uid) = t.register("player").await;
    sqlx::query(
        "INSERT INTO control_bindings (user_id, game_id, bindings, updated_at) \
         VALUES (?, ?, 'not json', '2026-01-01T00:00:00.000Z')",
    )
    .bind(&uid)
    .bind(&id)
    .execute(&t.state.db)
    .await
    .unwrap();
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json(), json!({ "bindings": null, "updatedAt": null }));
    // A PUT overwrites it.
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": { "gamepad": { "jump": ["B"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.json()["bindings"]["gamepad"], json!({ "jump": ["B"] }));
}

#[test]
fn normalize_dedups_drops_defaults_and_keeps_manifest_order() {
    let actions = vec![
        ControlAction {
            id: "b".into(),
            name: "B".into(),
            keys: vec!["KeyB".into()],
            gamepad: vec!["B".into()],
        },
        ControlAction {
            id: "a".into(),
            name: "A".into(),
            keys: vec!["KeyA".into(), "KeyS".into()],
            gamepad: vec!["A".into()],
        },
    ];
    let mut raw = RawBindings::default();
    raw.keys.insert(
        "a".into(),
        vec!["KeyA".into(), "KeyA".into(), "KeyS".into()],
    ); // dedup → defaults → dropped
    raw.keys
        .insert("b".into(), vec!["KeyQ".into(), "KeyQ".into()]);
    raw.keys.insert("c".into(), vec!["KeyC".into()]);
    raw.gamepad.insert("a".into(), vec!["X".into()]);
    raw.gamepad.insert("b".into(), vec!["Y".into()]);
    raw.gamepad.insert("a2".into(), vec!["Y".into()]);
    let n = normalize_bindings(&raw, &actions);
    assert_eq!(n.keys, vec![("b".to_string(), vec!["KeyQ".to_string()])]);
    assert_eq!(
        n.gamepad,
        vec![
            ("b".to_string(), vec!["Y".to_string()]),
            ("a".to_string(), vec!["X".to_string()]),
        ]
    );
    assert_eq!(
        serde_json::to_string(&n).unwrap(),
        r#"{"keys":{"b":["KeyQ"]},"gamepad":{"b":["Y"],"a":["X"]}}"#
    );
    // Order of defaults matters: a reversed list is an override.
    let mut raw = RawBindings::default();
    raw.keys
        .insert("a".into(), vec!["KeyS".into(), "KeyA".into()]);
    assert_eq!(normalize_bindings(&raw, &actions).keys.len(), 1);
    // No actions → everything dropped.
    assert_eq!(normalize_bindings(&raw, &[]), Default::default());
}

// ---------------------------------------------------------------- 422

/// (body, expected substring of the 422 message).
fn invalid_cases() -> Vec<(Value, String)> {
    let many: serde_json::Map<String, Value> = (0..33)
        .map(|i| (format!("a{i}"), json!(["KeyA"])))
        .collect();
    let many_pad: serde_json::Map<String, Value> =
        (0..33).map(|i| (format!("a{i}"), json!(["A"]))).collect();
    vec![
        (json!({}), "bindings must be a JSON object".into()),
        (
            json!({ "bindings": null }),
            "bindings must be a JSON object".into(),
        ),
        (
            json!({ "bindings": [] }),
            "bindings must be a JSON object".into(),
        ),
        (
            json!({ "bindings": "x" }),
            "bindings must be a JSON object".into(),
        ),
        (
            json!({ "bindings": { "keys": [] } }),
            "bindings.keys must be an object".into(),
        ),
        (
            json!({ "bindings": { "gamepad": "A" } }),
            "bindings.gamepad must be an object".into(),
        ),
        (
            json!({ "bindings": { "keys": Value::Object(many) } }),
            "bindings.keys must have at most 32 actions".into(),
        ),
        (
            json!({ "bindings": { "gamepad": Value::Object(many_pad) } }),
            "bindings.gamepad must have at most 32 actions".into(),
        ),
        (
            json!({ "bindings": { "keys": { "Jump!": ["Space"] } } }),
            r#"bindings.keys "Jump!" is not a valid action id"#.into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "a".repeat(33): ["A"] } } }),
            "is not a valid action id".into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": "Space" } } }),
            "bindings.keys.jump must be an array".into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": null } } }),
            "bindings.keys.jump must be an array".into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "jump": { "0": "A" } } } }),
            "bindings.gamepad.jump must be an array".into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": [32] } } }),
            "bindings.keys.jump[0] must be a string".into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": ["Space", "Escape"] } } }),
            r#"bindings.keys.jump[1] "Escape" can't be bound"#.into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": ["F5"] } } }),
            r#"bindings.keys.jump[0] "F5" can't be bound"#.into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": ["KeyA", "KeyB", "KeyC", "KeyD"] } } }),
            "bindings.keys.jump must have at most 3 entries".into(),
        ),
        (
            json!({ "bindings": { "keys": { "jump": ["KeyA", "KeyA"] } } }),
            r#"bindings.keys.jump[1] "KeyA" is a duplicate"#.into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "jump": ["Home"] } } }),
            r#"bindings.gamepad.jump[0] "Home" can't be bound"#.into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "jump": ["A", "Triangle"] } } }),
            r#"bindings.gamepad.jump[1] "Triangle" can't be bound"#.into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "jump": ["A", "B", "X"] } } }),
            "bindings.gamepad.jump must have at most 2 entries".into(),
        ),
        (
            json!({ "bindings": { "gamepad": { "jump": ["B", "B"] } } }),
            r#"bindings.gamepad.jump[1] "B" is a duplicate"#.into(),
        ),
        (
            // Gamepad names are not key codes and vice versa.
            json!({ "bindings": { "keys": { "jump": ["A"] } } }),
            r#"bindings.keys.jump[0] "A" can't be bound"#.into(),
        ),
    ]
}

#[tokio::test]
async fn every_invalid_body_is_422_naming_the_path() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    for (body, msg) in invalid_cases() {
        let r = put_controls(&t, Some(&p), &id, body.clone()).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation", "{body}");
        let m = r.json()["error"]["message"].as_str().unwrap().to_string();
        assert!(m.contains(&msg), "{body}: expected {msg:?} in {m:?}");
    }
    assert_eq!(row_count(&t, &id).await, 0);
}

#[test]
fn validate_bindings_accepts_bounds() {
    let keys: serde_json::Map<String, Value> = (0..32)
        .map(|i| (format!("a-{i}_x"), json!(["KeyA", "KeyB", "Mouse2"])))
        .collect();
    let v = json!({ "keys": keys, "gamepad": { "a": ["A", "Right"], "b": [] } });
    let raw = validate_bindings(Some(&v)).unwrap();
    assert_eq!(raw.keys.len(), 32);
    assert_eq!(raw.gamepad["b"], Vec::<String>::new());
}

// ---------------------------------------------------------------- 413

#[tokio::test]
async fn body_over_16_kib_is_413() {
    let (t, _, id) = world().await;
    let (p, _) = t.register("player").await;
    let body = json!({ "bindings": {}, "pad": "x".repeat(17 * 1024) });
    let r = put_controls(&t, Some(&p), &id, body).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.text());
    assert_eq!(r.error_code(), "payload_too_large");
    assert_eq!(row_count(&t, &id).await, 0);

    // Just under the limit is fine.
    let body = json!({ "bindings": {}, "pad": "x".repeat(15 * 1024) });
    let r = put_controls(&t, Some(&p), &id, body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------- rate limit

#[tokio::test]
async fn put_is_limited_to_60_per_minute_per_user() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owner").await;
    let id = upload(&t, &owner, default_actions(), true).await;
    let (p, _) = t.register("player").await;
    let (q, _) = t.register("other").await;
    let body = json!({ "bindings": { "gamepad": { "jump": ["B"] } } });

    // The visibility 404 comes first and doesn't consume tokens.
    for _ in 0..5 {
        let r = put_controls(&t, Some(&p), "no-such-game", body.clone()).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
    }
    for i in 0..60 {
        let r = put_controls(&t, Some(&p), &id, body.clone()).await;
        assert_eq!(r.status, StatusCode::OK, "PUT {i}: {}", r.text());
    }
    let r = put_controls(&t, Some(&p), &id, body.clone()).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    let retry: u64 = r.header("retry-after").parse().unwrap();
    assert!((1..=60).contains(&retry), "{retry}");

    // GET is never limited; other users have their own bucket.
    for _ in 0..70 {
        assert_eq!(get_controls(&t, Some(&p), &id).await.status, StatusCode::OK);
    }
    let r = put_controls(&t, Some(&q), &id, body.clone()).await;
    assert_eq!(r.status, StatusCode::OK);

    t.clock.advance(Duration::from_secs(60));
    let r = put_controls(&t, Some(&p), &id, body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
}

// ---------------------------------------------------------------- bundle replace

#[tokio::test]
async fn get_filters_against_the_current_actions_after_a_replace() {
    let (t, owner, id) = world().await;
    let (p, _) = t.register("player").await;
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": {
            "keys": { "jump": ["KeyK"], "fire": ["KeyF"] },
            "gamepad": { "jump": ["B"], "fire": ["Y"] },
        } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());

    // v2 removes `fire`.
    replace(
        &t,
        &owner,
        &id,
        json!([
            { "id": "left", "name": "Left", "keys": ["ArrowLeft"], "gamepad": ["Left"] },
            { "id": "jump", "name": "Jump", "keys": ["Space", "ArrowUp"], "gamepad": ["A"] },
        ]),
    )
    .await;
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(
        r.json()["bindings"],
        json!({ "keys": { "jump": ["KeyK"] }, "gamepad": { "jump": ["B"] } })
    );

    // v3 makes `jump`'s gamepad default the stored override (B) and brings `fire` back.
    replace(
        &t,
        &owner,
        &id,
        json!([
            { "id": "jump", "name": "Jump", "keys": ["Space"], "gamepad": ["B"] },
            { "id": "fire", "name": "Fire", "keys": ["KeyX"], "gamepad": ["X"] },
        ]),
    )
    .await;
    let r = get_controls(&t, Some(&p), &id).await;
    // The row was never rewritten, so `fire` (still stored) reappears; jump's gamepad entry
    // now equals the defaults and is dropped.
    assert_eq!(
        r.json()["bindings"],
        json!({
            "keys": { "jump": ["KeyK"], "fire": ["KeyF"] },
            "gamepad": { "fire": ["Y"] },
        })
    );

    // v4 declares no actions: everything is filtered, but the row still exists (not null).
    replace(&t, &owner, &id, json!([])).await;
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.json()["bindings"], json!({ "keys": {}, "gamepad": {} }));
}

// ---------------------------------------------------------------- isolation and cascade

#[tokio::test]
async fn users_are_isolated() {
    let (t, _, id) = world().await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    let r = put_controls(
        &t,
        Some(&a),
        &id,
        json!({ "bindings": { "gamepad": { "jump": ["B"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);

    let r = get_controls(&t, Some(&b), &id).await;
    assert_eq!(r.json(), json!({ "bindings": null, "updatedAt": null }));

    let r = put_controls(
        &t,
        Some(&b),
        &id,
        json!({ "bindings": { "gamepad": { "jump": ["Y"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = get_controls(&t, Some(&a), &id).await;
    assert_eq!(r.json()["bindings"]["gamepad"], json!({ "jump": ["B"] }));
    let r = get_controls(&t, Some(&b), &id).await;
    assert_eq!(r.json()["bindings"]["gamepad"], json!({ "jump": ["Y"] }));
    assert_eq!(row_count(&t, &id).await, 2);

    // Bindings aren't exposed on the game.
    let g = t.get(&format!("/api/games/{id}"), Some(&b)).await.json();
    assert!(!g.to_string().contains("\"Y\""));
}

#[tokio::test]
async fn deleting_the_game_deletes_its_bindings() {
    let (t, owner, id) = world().await;
    let other = upload(&t, &owner, default_actions(), true).await;
    let (p, _) = t.register("player").await;
    let body = json!({ "bindings": { "gamepad": { "jump": ["B"] } } });
    for g in [&id, &other] {
        let r = put_controls(&t, Some(&p), g, body.clone()).await;
        assert_eq!(r.status, StatusCode::OK);
    }
    assert_eq!(row_count(&t, &id).await, 1);

    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{id}"),
            Some(&owner),
            None,
            vec![],
            &[],
        )
        .await;
    assert!(r.status.is_success(), "{}", r.text());
    assert_eq!(row_count(&t, &id).await, 0);
    assert_eq!(row_count(&t, &other).await, 1);
    let r = get_controls(&t, Some(&p), &id).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deleting_the_user_deletes_their_bindings() {
    let (t, _, id) = world().await;
    let (p, uid) = t.register("player").await;
    let r = put_controls(
        &t,
        Some(&p),
        &id,
        json!({ "bindings": { "gamepad": { "jump": ["B"] } } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    // No user-delete endpoint exists; exercise the FK directly.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&uid)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(row_count(&t, &id).await, 0);
}
