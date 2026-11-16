//! F009: controls overlay and key remapping (docs/API.md § F009 additions,
//! docs/GAME_FORMAT.md § F009 additions, docs/ARCHITECTURE.md § F009 additions).

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::{Value, json};
use webgame_server::bundle::{
    BINDABLE_KEYS, GAMEPAD_BUTTONS, parse_actions, parse_controls_hint, validate,
};
use webgame_server::controls_backfill::backfill_controls;

const MAIN_JS: &[u8] = b"export default { update() {}, render() {} };";

/// A bundle whose game.json is the base manifest merged with `extra`.
fn bundle_with(extra: Value) -> Vec<u8> {
    let mut manifest = json!({ "name": "Ctl", "entry": "main.js", "width": 320, "height": 240 });
    if let (Some(m), Some(e)) = (manifest.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            m.insert(k.clone(), v.clone());
        }
    }
    let gj = serde_json::to_vec(&manifest).unwrap();
    make_zip(&[("game.json", &gj), ("main.js", MAIN_JS)])
}

async fn upload(t: &TestApp, tok: &str, zip: &[u8]) -> Resp {
    t.multipart(
        Method::POST,
        "/api/games",
        Some(tok),
        &[
            Part::Text("published", "true"),
            Part::File("bundle", "game.zip", "application/zip", zip),
        ],
    )
    .await
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

fn action(id: &str, name: &str, keys: Value) -> Value {
    json!({ "id": id, "name": name, "keys": keys })
}

/// Each case: (actions value, expected substring of the 422 message).
fn invalid_cases() -> Vec<(Value, &'static str)> {
    let many: Vec<Value> = (0..33)
        .map(|i| action(&format!("a{i}"), "A", json!(["KeyA"])))
        .collect();
    vec![
        (json!({ "id": "x" }), "game.json: actions must be an array"),
        (json!("jump"), "game.json: actions must be an array"),
        (
            Value::Array(many),
            "game.json: at most 32 actions are allowed",
        ),
        (
            json!([action("Jump", "Jump", json!(["Space"]))]),
            "game.json: actions[0].id must match ^[a-z0-9_-]{1,32}$",
        ),
        (
            json!([action(&"a".repeat(33), "Jump", json!(["Space"]))]),
            "actions[0].id must match",
        ),
        (
            json!([{ "name": "Jump", "keys": ["Space"] }]),
            "actions[0].id must match",
        ),
        (
            json!([
                action("jump", "Jump", json!(["Space"])),
                action("jump", "Jump 2", json!(["KeyW"]))
            ]),
            "game.json: actions[1].id \"jump\" is a duplicate",
        ),
        (
            json!([action("jump", "   ", json!(["Space"]))]),
            "actions[0].name must be 1-40 characters",
        ),
        (
            json!([action("jump", &"n".repeat(41), json!(["Space"]))]),
            "actions[0].name must be 1-40 characters",
        ),
        (
            json!([{ "id": "jump", "keys": ["Space"] }]),
            "actions[0].name must be a string",
        ),
        (
            json!([action("jump", "Ju\u{7}mp", json!(["Space"]))]),
            "actions[0].name contains invalid characters",
        ),
        (
            json!([action("jump", "Ju\u{85}mp", json!(["Space"]))]),
            "actions[0].name contains invalid characters",
        ),
        (
            json!([action("jump", "Ju\u{202E}mp", json!(["Space"]))]),
            "actions[0].name contains invalid characters",
        ),
        (
            json!([action("jump", "Jump", json!(["Space", 5]))]),
            "actions[0].keys[1] must be a string",
        ),
        (
            json!([
                action("left", "Left", json!(["KeyA"])),
                action("right", "Right", json!(["KeyD"])),
                action("jump", "Jump", json!(["Space", "Escape"]))
            ]),
            "game.json: actions[2].keys[1] \"Escape\" can't be bound",
        ),
        (
            json!([action("jump", "Jump", json!(["Tab"]))]),
            "actions[0].keys[0] \"Tab\" can't be bound",
        ),
        (
            json!([action("jump", "Jump", json!(["F5"]))]),
            "actions[0].keys[0] \"F5\" can't be bound",
        ),
        (
            json!([action("jump", "Jump", json!(["MetaLeft"]))]),
            "actions[0].keys[0] \"MetaLeft\" can't be bound",
        ),
        (
            json!([action("jump", "Jump", json!(["Space", "Space"]))]),
            "actions[0].keys[1] \"Space\" is a duplicate",
        ),
        (
            json!([action(
                "jump",
                "Jump",
                json!(["KeyA", "KeyB", "KeyC", "KeyD"])
            )]),
            "actions[0].keys must have at most 3 entries",
        ),
        (
            json!([action("jump", "Jump", json!("Space"))]),
            "actions[0].keys must be an array",
        ),
        (
            json!([{ "id": "jump", "name": "Jump", "gamepad": ["Home"] }]),
            "actions[0].gamepad[0] \"Home\" is not a gamepad button",
        ),
        (
            json!([{ "id": "jump", "name": "Jump", "gamepad": ["A", "B", "X"] }]),
            "actions[0].gamepad must have at most 2 entries",
        ),
        (
            json!([{ "id": "jump", "name": "Jump" }]),
            "game.json: actions[0] needs at least one key or gamepad button",
        ),
        (
            json!([{ "id": "jump", "name": "Jump", "keys": [], "gamepad": [] }]),
            "actions[0] needs at least one key or gamepad button",
        ),
        (json!(["jump"]), "actions[0] must be an object"),
    ]
}

#[test]
fn key_tables() {
    assert_eq!(BINDABLE_KEYS.len(), 86);
    assert_eq!(GAMEPAD_BUTTONS.len(), 16);
    for k in [
        "KeyA",
        "Digit0",
        "NumpadEnter",
        "ArrowUp",
        "IntlBackslash",
        "PageDown",
        "Mouse2",
    ] {
        assert!(BINDABLE_KEYS.contains(&k), "{k}");
    }
    for k in [
        "Escape",
        "Tab",
        "F1",
        "MetaLeft",
        "CapsLock",
        "ContextMenu",
        "NumLock",
    ] {
        assert!(!BINDABLE_KEYS.contains(&k), "{k}");
    }
    assert!(!GAMEPAD_BUTTONS.contains(&"Home"));
    let unique: std::collections::HashSet<_> = BINDABLE_KEYS.iter().collect();
    assert_eq!(unique.len(), 86);
}

#[test]
fn parse_actions_unit() {
    assert!(parse_actions(&json!({})).unwrap().is_empty());
    assert!(
        parse_actions(&json!({ "actions": null }))
            .unwrap()
            .is_empty()
    );
    for (actions, msg) in invalid_cases() {
        let err = parse_actions(&json!({ "actions": actions })).unwrap_err();
        assert!(err.to_string().contains(msg), "{err} !~ {msg}");
    }
    // Exactly 32 actions, 3 keys, 2 gamepad buttons, 40-char name: accepted.
    let max: Vec<Value> = (0..32)
        .map(|i| {
            json!({ "id": format!("a{i}"), "name": "n".repeat(40),
                    "keys": ["KeyA", "KeyB", "Mouse0"], "gamepad": ["A", "Up"] })
        })
        .collect();
    assert_eq!(parse_actions(&json!({ "actions": max })).unwrap().len(), 32);
}

#[test]
fn controls_hint_unit() {
    let h = |v: Value| parse_controls_hint(&json!({ "controls": v }));
    assert_eq!(h(json!(5)), "");
    assert_eq!(h(json!({ "a": 1 })), "");
    assert_eq!(h(json!(["x"])), "");
    assert_eq!(parse_controls_hint(&json!({})), "");
    assert_eq!(
        h(json!("  Arrows\tmove,\n\nSpace\r\nshoots  ")),
        "Arrows move, Space shoots"
    );
    assert_eq!(h(json!("a   b\u{202E}c\u{0}d")), "a bc d");
    assert_eq!(h(json!("x".repeat(500))).chars().count(), 300);
    assert_eq!(h(json!("é".repeat(500))).chars().count(), 300);
    assert_eq!(h(json!(" \n\t ")), "");
}

#[tokio::test]
async fn upload_normalises_actions_and_hint() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let zip = bundle_with(json!({
        "actions": [
            { "id": "jump", "name": "  Jump  ", "keys": ["Space", "ArrowUp"], "gamepad": ["A"],
              "extra": true, "label": "x" },
            { "id": "fire", "name": "Fire", "keys": ["Mouse0"] },
            { "id": "pad_only", "name": "Pause", "gamepad": ["Start"] }
        ],
        "controls": "Arrows move,\nSpace   jumps"
    }));
    let r = upload(&t, &tok, &zip).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let g = r.json();
    assert_eq!(
        g["actions"],
        json!([
            { "id": "jump", "name": "Jump", "keys": ["Space", "ArrowUp"], "gamepad": ["A"] },
            { "id": "fire", "name": "Fire", "keys": ["Mouse0"], "gamepad": [] },
            { "id": "pad_only", "name": "Pause", "keys": [], "gamepad": ["Start"] }
        ])
    );
    assert_eq!(g["controlsHint"], "Arrows move, Space jumps");

    let id = g["id"].as_str().unwrap();
    let got = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(got["actions"], g["actions"]);
    assert_eq!(got["controlsHint"], g["controlsHint"]);

    // Stored compact, normalised copy.
    let stored: (String, String) =
        sqlx::query_as("SELECT actions_json, controls_hint FROM games WHERE id = ?")
            .bind(id)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    let parsed: Value = serde_json::from_str(&stored.0).unwrap();
    assert_eq!(parsed, g["actions"]);
    assert!(!stored.0.contains(": ") && !stored.0.contains('\n'));
    assert!(!stored.0.contains("extra"));
    assert_eq!(stored.1, "Arrows move, Space jumps");

    // GameSummary is unchanged.
    let list = t.get("/api/games", None).await.json();
    let item = &list["items"][0];
    assert!(item.get("actions").is_none());
    assert!(item.get("controlsHint").is_none());

    // A game without either key.
    let plain = t.create_game(&tok, "Plain", "", true).await;
    assert_eq!(plain["actions"], json!([]));
    assert_eq!(plain["controlsHint"], "");
}

#[tokio::test]
async fn invalid_actions_are_422_on_upload_and_replace() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let base = t.create_game(&tok, "Base", "", true).await;
    let id = base["id"].as_str().unwrap();
    for (actions, msg) in invalid_cases() {
        let zip = bundle_with(json!({ "actions": actions }));
        for r in [
            upload(&t, &tok, &zip).await,
            replace(&t, &tok, id, &zip).await,
        ] {
            assert_eq!(
                r.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{msg}: {}",
                r.text()
            );
            assert_eq!(r.error_code(), "validation");
            let m = r.json()["error"]["message"].as_str().unwrap().to_string();
            assert!(m.contains(msg), "{m} !~ {msg}");
        }
    }
    // Nothing was created and the replace never went live.
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(g["version"], 1);
}

#[tokio::test]
async fn lenient_controls_never_422() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    for (controls, expected) in [
        (json!(42), String::new()),
        (json!({ "move": "arrows" }), String::new()),
        (json!(null), String::new()),
        (json!("y".repeat(500)), "y".repeat(300)),
        (json!("A\tB\n\nC   D"), "A B C D".to_string()),
    ] {
        let r = upload(&t, &tok, &bundle_with(json!({ "controls": controls }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        assert_eq!(r.json()["controlsHint"], expected);
    }
}

#[tokio::test]
async fn replace_updates_and_clears() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let v1 = bundle_with(json!({
        "actions": [{ "id": "jump", "name": "Jump", "keys": ["Space"] }],
        "controls": "Space jumps"
    }));
    let g = upload(&t, &tok, &v1).await.json();
    let id = g["id"].as_str().unwrap();

    let v2 = bundle_with(json!({
        "actions": [
            { "id": "fire", "name": "Fire", "keys": ["KeyZ"] },
            { "id": "jump", "name": "Hop", "keys": ["KeyW"], "gamepad": ["A"] }
        ],
        "controls": "Z fires"
    }));
    let r = replace(&t, &tok, id, &v2).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let g = r.json();
    assert_eq!(g["version"], 2);
    assert_eq!(g["actions"][0]["id"], "fire");
    assert_eq!(g["actions"][1]["name"], "Hop");
    assert_eq!(g["controlsHint"], "Z fires");

    // A replace without `actions` / `controls` clears both.
    let r = replace(&t, &tok, id, &bundle_with(json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let g = t.get(&format!("/api/games/{id}"), None).await.json();
    assert_eq!(g["version"], 3);
    assert_eq!(g["actions"], json!([]));
    assert_eq!(g["controlsHint"], "");
}

#[tokio::test]
async fn player_page_renders_escaped_actions() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let zip = bundle_with(json!({
        "actions": [
            { "id": "jump", "name": "a</script><b>&\u{2028}x", "keys": ["Space"], "gamepad": ["A"] }
        ]
    }));
    let g = upload(&t, &tok, &zip).await.json();
    let id = g["id"].as_str().unwrap();
    assert_eq!(g["actions"][0]["name"], "a</script><b>&\u{2028}x");

    let r = t.get(&format!("/play/{id}"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("cache-control"), "no-cache");
    let html = r.text();
    let expected = "baseUrl: base, actions: [{\"id\":\"jump\",\"name\":\
        \"a\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028x\",\"keys\":[\"Space\"],\
        \"gamepad\":[\"A\"]}] });";
    assert!(html.contains(expected), "{html}");
    // The only closing script tag is the page's own.
    assert_eq!(html.matches("</script>").count(), 1);
    assert!(!html.contains('\u{2028}'));

    // A game without actions renders `[]`; a NULL column (not yet backfilled) too.
    let plain = t.create_game(&tok, "Plain", "", true).await;
    let pid = plain["id"].as_str().unwrap();
    let html = t.get(&format!("/play/{pid}"), None).await.text();
    assert!(html.contains("baseUrl: base, actions: [] });"));
    sqlx::query("UPDATE games SET actions_json = NULL, controls_hint = NULL WHERE id = ?")
        .bind(pid)
        .execute(&t.state.db)
        .await
        .unwrap();
    let html = t.get(&format!("/play/{pid}"), None).await.text();
    assert!(html.contains("baseUrl: base, actions: [] });"));
    let g = t.get(&format!("/api/games/{pid}"), None).await.json();
    assert_eq!(g["actions"], json!([]));
    assert_eq!(g["controlsHint"], "");

    // An unparsable stored value is read as [].
    sqlx::query("UPDATE games SET actions_json = '{nope' WHERE id = ?")
        .bind(pid)
        .execute(&t.state.db)
        .await
        .unwrap();
    let g = t.get(&format!("/api/games/{pid}"), None).await.json();
    assert_eq!(g["actions"], json!([]));
}

#[test]
fn js_json_literal_escapes() {
    use webgame_server::routes::play::js_json_literal;
    assert_eq!(
        js_json_literal("[\"</script>&\u{2028}\u{2029}\"]"),
        "[\"\\u003c/script\\u003e\\u0026\\u2028\\u2029\"]"
    );
    assert_eq!(js_json_literal("[]"), "[]");
}

#[tokio::test]
async fn studio_page_passes_manifest_actions() {
    let t = setup().await;
    let r = t.get("/play/studio", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text().contains("actions: manifest.actions,"));
}

/// Make a game look like it was stored before F009, with `game_json` as its current
/// version's file (`None` = delete the file).
async fn make_legacy(t: &TestApp, id: &str, game_json: Option<&str>) {
    sqlx::query("UPDATE games SET actions_json = NULL, controls_hint = NULL WHERE id = ?")
        .bind(id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let version: i64 = sqlx::query_scalar("SELECT version FROM games WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let path = t.state.storage.version_dir(id, version).join("game.json");
    match game_json {
        Some(s) => std::fs::write(&path, s).unwrap(),
        None => std::fs::remove_file(&path).unwrap(),
    }
}

async fn stored(t: &TestApp, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT actions_json, controls_hint FROM games WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn backfill_existing_games() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let ok = t.create_game(&tok, "Ok", "", true).await;
    let bad = t.create_game(&tok, "Bad", "", true).await;
    let gone = t.create_game(&tok, "Gone", "", true).await;
    let fresh = t.create_game(&tok, "Fresh", "", true).await;
    let (ok, bad, gone, fresh) = (
        ok["id"].as_str().unwrap(),
        bad["id"].as_str().unwrap(),
        gone["id"].as_str().unwrap(),
        fresh["id"].as_str().unwrap(),
    );
    make_legacy(
        &t,
        ok,
        Some(
            r#"{ "entry": "main.js", "width": 320, "height": 240,
                 "actions": [{ "id": "jump", "name": " Jump ", "keys": ["Space"], "x": 1 }],
                 "controls": "Space\njumps" }"#,
        ),
    )
    .await;
    make_legacy(
        &t,
        bad,
        Some(
            r#"{ "entry": "main.js", "width": 320, "height": 240,
                 "actions": [{ "id": "jump", "name": "Jump", "keys": ["Escape"] }],
                 "controls": "Esc jumps" }"#,
        ),
    )
    .await;
    make_legacy(&t, gone, None).await;

    // Before the backfill, NULL columns read as [] / "".
    let g = t.get(&format!("/api/games/{ok}"), None).await.json();
    assert_eq!(g["actions"], json!([]));
    assert_eq!(g["controlsHint"], "");

    assert_eq!(backfill_controls(&t.state).await.unwrap(), 3);

    let g = t.get(&format!("/api/games/{ok}"), None).await.json();
    assert_eq!(
        g["actions"],
        json!([{ "id": "jump", "name": "Jump", "keys": ["Space"], "gamepad": [] }])
    );
    assert_eq!(g["controlsHint"], "Space jumps");
    assert_eq!(
        stored(&t, bad).await,
        (Some("[]".into()), Some("Esc jumps".into()))
    );
    assert_eq!(
        stored(&t, gone).await,
        (Some("[]".into()), Some(String::new()))
    );
    // Untouched: already filled at upload.
    assert_eq!(
        stored(&t, fresh).await,
        (Some("[]".into()), Some(String::new()))
    );

    // Idempotent.
    assert_eq!(backfill_controls(&t.state).await.unwrap(), 0);
}

#[tokio::test]
async fn backfill_handles_many_rows_and_oversize_files() {
    let t = setup().await;
    let (tok, _) = t.register("ctl").await;
    let g = t.create_game(&tok, "Big", "", true).await;
    let id = g["id"].as_str().unwrap();
    let mut big = String::from(r#"{ "controls": "huge", "pad": ""#);
    big.push_str(&"x".repeat(1024 * 1024));
    big.push_str("\" }");
    make_legacy(&t, id, Some(&big)).await;
    // Rows beyond one batch (fake rows sharing the owner; no files on disk).
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM games WHERE id = ?")
        .bind(id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    for i in 0..250 {
        sqlx::query(
            "INSERT INTO games (id, owner_id, title, description, published, version, entry, \
             width, height, created_at, updated_at) \
             VALUES (?, ?, 'T', '', 0, 1, 'main.js', 320, 240, '2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z')",
        )
        .bind(format!("fake-{i:03}"))
        .bind(&owner)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    assert_eq!(backfill_controls(&t.state).await.unwrap(), 251);
    assert_eq!(
        stored(&t, id).await,
        (Some("[]".into()), Some(String::new()))
    );
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE actions_json IS NULL")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

/// The example sources' game.json files (`examples/*/game.json`) pass the strict rules, so a
/// repack can't produce a bundle the upload path rejects.
#[test]
fn example_manifests_validate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
    let Ok(dir) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in dir.flatten() {
        let path = entry.path().join("game.json");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        parse_actions(&v).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(parse_controls_hint(&v).chars().count() <= 300);
    }
}

#[test]
fn packed_examples_validate() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/dist");
    let Ok(dir) = std::fs::read_dir(&dist) else {
        return;
    };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "zip") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let meta = validate(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(meta.controls_hint.chars().count() <= 300);
        for a in &meta.actions {
            assert!(!a.keys.is_empty() || !a.gamepad.is_empty(), "{}", a.id);
        }
    }
}
