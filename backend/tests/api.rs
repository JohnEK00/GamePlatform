mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;

#[tokio::test]
async fn health() {
    let t = setup().await;
    let r = t.get("/api/health", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["status"], "ok");
    assert!(r.json()["version"].is_string());

    let r = t.get("/api/nope", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
}

#[tokio::test]
async fn register_login_me() {
    let t = setup().await;
    let r = t
        .json(
            Method::POST,
            "/api/auth/register",
            None,
            json!({"username": "Alice_1", "email": "alice@example.com", "password": "password123"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let v = r.json();
    assert_eq!(v["user"]["username"], "Alice_1");
    assert_eq!(v["user"]["displayName"], "Alice_1");
    assert!(v["user"]["avatarUrl"].is_null());
    assert_eq!(v["user"]["bio"], "");
    assert!(v["user"]["createdAt"].is_string());
    assert!(v["user"].get("email").is_none());
    let token = v["token"].as_str().unwrap().to_string();

    // Duplicate username (case-insensitive) → 409.
    let r = t
        .json(
            Method::POST,
            "/api/auth/register",
            None,
            json!({"username": "alice_1", "email": "other@example.com", "password": "password123"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.error_code(), "conflict");

    // Validation errors → 422.
    for body in [
        json!({"username": "ab", "email": "x@example.com", "password": "password123"}),
        json!({"username": "bad name", "email": "x@example.com", "password": "password123"}),
        json!({"username": "bob", "email": "x@example.com", "password": "short"}),
        json!({"username": "bob", "email": "nope", "password": "password123"}),
    ] {
        let r = t.json(Method::POST, "/api/auth/register", None, body).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
        assert_eq!(r.error_code(), "validation");
    }

    // Login by username and by email.
    for login in ["alice_1", "ALICE@example.com"] {
        let r = t
            .json(
                Method::POST,
                "/api/auth/login",
                None,
                json!({"login": login, "password": "password123"}),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        assert_eq!(r.json()["user"]["username"], "Alice_1");
    }
    let r = t
        .json(
            Method::POST,
            "/api/auth/login",
            None,
            json!({"login": "alice_1", "password": "wrongpassword"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.error_code(), "unauthorized");

    let r = t.get("/api/auth/me", Some(&token)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["username"], "Alice_1");
    let r = t.get("/api/auth/me", None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.get("/api/auth/me", Some("garbage")).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Malformed JSON → 400.
    let r = t
        .send(
            Method::POST,
            "/api/auth/login",
            None,
            Some("application/json"),
            b"{not json".to_vec(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.error_code(), "bad_request");
}

#[tokio::test]
async fn user_profile_and_patch_me() {
    let t = setup().await;
    let (tok, _) = t.register("carol").await;
    t.create_game(&tok, "Public", "", true).await;
    t.create_game(&tok, "Hidden", "", false).await;

    let r = t
        .json(
            Method::PATCH,
            "/api/users/me",
            Some(&tok),
            json!({"displayName": "Carol C", "bio": "hi"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["displayName"], "Carol C");
    assert_eq!(r.json()["bio"], "hi");

    let r = t.get("/api/users/CAROL", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["user"]["displayName"], "Carol C");
    assert_eq!(r.json()["games"].as_array().unwrap().len(), 1);
    let r = t.get("/api/users/carol", Some(&tok)).await;
    assert_eq!(r.json()["games"].as_array().unwrap().len(), 2);
    assert_eq!(
        t.get("/api/users/nobody", None).await.status,
        StatusCode::NOT_FOUND
    );

    // Avatar upload.
    let png = png_bytes();
    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/avatar",
            Some(&tok),
            &[Part::File("avatar", "a.png", "image/png", &png)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let url = r.json()["avatarUrl"].as_str().unwrap().to_string();
    assert!(url.starts_with("/media/avatars/") && url.contains(".png?v=1"));
    let r = t.get(url.as_str(), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("access-control-allow-origin"), "*");

    let r = t
        .multipart(
            Method::PUT,
            "/api/users/me/avatar",
            Some(&tok),
            &[Part::File("avatar", "a.txt", "text/plain", b"hello")],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn upload_valid_and_invalid_bundles() {
    let t = setup().await;
    let (tok, uid) = t.register("dave").await;

    let png = png_bytes();
    let zip = valid_bundle();
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[
                Part::Text("title", "  My Game "),
                Part::Text("description", "desc"),
                Part::Text("tags", "Action, arcade,,ACTION"),
                Part::File("bundle", "g.zip", "application/zip", &zip),
                Part::File("thumbnail", "t.png", "image/png", &png),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    let g = r.json();
    assert_eq!(g["title"], "My Game");
    assert_eq!(g["tags"], json!(["action", "arcade"]));
    assert_eq!(g["owner"]["id"], uid.as_str());
    assert_eq!(g["width"], 800);
    assert_eq!(g["height"], 600);
    assert_eq!(g["version"], 1);
    assert_eq!(g["entry"], "main.js");
    assert_eq!(g["published"], true);
    assert_eq!(g["isOwner"], true);
    assert!(g["myRating"].is_null());
    assert_eq!(g["plays"], 0);
    assert_eq!(g["ratingAvg"], 0.0);
    let id = g["id"].as_str().unwrap().to_string();
    assert_eq!(g["playUrl"], format!("/play/{id}"));
    let thumb = g["thumbnailUrl"].as_str().unwrap();
    assert_eq!(thumb, format!("/media/thumbnails/{id}.png?v=1"));
    assert_eq!(t.get(thumb, None).await.status, StatusCode::OK);

    // Single top-level folder is stripped.
    let nested = make_zip(&[
        ("my-game/game.json", GAME_JSON.as_bytes()),
        ("my-game/main.js", b"export default {};"),
        ("__MACOSX/my-game/._main.js", b"junk"),
    ]);
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[Part::File("bundle", "g.zip", "application/zip", &nested)],
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    // Title falls back to game.json name when omitted.
    assert_eq!(r.json()["title"], "Space Dodge");
    let nested_id = r.json()["id"].as_str().unwrap().to_string();
    let r = t
        .get(&format!("/games/{nested_id}/files/main.js"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);

    // Invalid bundles → 422 validation.
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("not a zip", b"definitely not a zip".to_vec()),
        (
            "zip slip",
            make_zip(&[
                ("game.json", GAME_JSON.as_bytes()),
                ("main.js", b"x"),
                ("../evil.js", b"x"),
            ]),
        ),
        (
            "absolute path",
            make_zip(&[
                ("game.json", GAME_JSON.as_bytes()),
                ("main.js", b"x"),
                ("/etc/evil.js", b"x"),
            ]),
        ),
        (
            "bad extension",
            make_zip(&[
                ("game.json", GAME_JSON.as_bytes()),
                ("main.js", b"x"),
                ("run.exe", b"x"),
            ]),
        ),
        ("missing game.json", make_zip(&[("main.js", b"x")])),
        (
            "missing entry file",
            make_zip(&[("game.json", GAME_JSON.as_bytes())]),
        ),
        (
            "bad dimensions",
            make_zip(&[
                (
                    "game.json",
                    br#"{"entry":"main.js","width":10,"height":600}"#.as_slice(),
                ),
                ("main.js", b"x"),
            ]),
        ),
        (
            "entry traversal",
            make_zip(&[
                (
                    "game.json",
                    br#"{"entry":"../main.js","width":100,"height":100}"#.as_slice(),
                ),
                ("main.js", b"x"),
            ]),
        ),
        (
            "invalid json",
            make_zip(&[("game.json", b"{nope".as_slice()), ("main.js", b"x")]),
        ),
    ];
    for (name, zip) in cases {
        let r = t
            .multipart(
                Method::POST,
                "/api/games",
                Some(&tok),
                &[
                    Part::Text("title", "Bad"),
                    Part::File("bundle", "g.zip", "application/zip", &zip),
                ],
            )
            .await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "case {name}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation", "case {name}");
    }

    // Symlink entries are rejected.
    let symlink_zip = {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("game.json", o).unwrap();
        w.write_all(GAME_JSON.as_bytes()).unwrap();
        w.start_file("main.js", o).unwrap();
        w.write_all(b"x").unwrap();
        w.add_symlink("assets/link.png", "/etc/passwd", o).unwrap();
        w.finish().unwrap().into_inner()
    };
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[Part::File(
                "bundle",
                "g.zip",
                "application/zip",
                &symlink_zip,
            )],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());

    // No escaped files anywhere around the data dir.
    assert!(
        !t.dir
            .path()
            .join("data")
            .join("games")
            .join("evil.js")
            .exists()
    );
    assert!(!t.dir.path().join("evil.js").exists());

    // Missing bundle / bad title / auth.
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[Part::Text("title", "x")],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let long = "x".repeat(81);
    let zip = valid_bundle();
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[
                Part::Text("title", &long),
                Part::File("bundle", "g.zip", "application/zip", &zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            Some(&tok),
            &[
                Part::Text("title", "ok"),
                Part::Text("tags", "a,b,c,d,e,f,g,h,i"),
                Part::File("bundle", "g.zip", "application/zip", &zip),
            ],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t
        .multipart(
            Method::POST,
            "/api/games",
            None,
            &[Part::File("bundle", "g.zip", "application/zip", &zip)],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bundle_reupload_bumps_version_and_removes_old_dir() {
    let t = setup().await;
    let (tok, _) = t.register("erin").await;
    let g = t.create_game(&tok, "Game", "", true).await;
    let id = g["id"].as_str().unwrap();

    let new_zip = make_zip(&[
        (
            "game.json",
            br#"{"entry":"src/app.js","width":320,"height":240}"#.as_slice(),
        ),
        ("src/app.js", b"export default {};"),
    ]);
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{id}/bundle"),
            Some(&tok),
            &[Part::File("bundle", "g.zip", "application/zip", &new_zip)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["version"], 2);
    assert_eq!(v["entry"], "src/app.js");
    assert_eq!(v["width"], 320);
    let game_dir = t.state.storage.game_dir(id);
    assert!(game_dir.join("v2").join("src").join("app.js").exists());
    assert!(!game_dir.join("v1").exists());
    assert_eq!(
        t.get(&format!("/games/{id}/files/main.js"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Thumbnail replace.
    let png = png_bytes();
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{id}/thumbnail"),
            Some(&tok),
            &[Part::File("thumbnail", "t.png", "image/png", &png)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["thumbnailUrl"].as_str().unwrap().ends_with("?v=1"));

    // Non-owner cannot re-upload.
    let (other, _) = t.register("frank").await;
    let r = t
        .multipart(
            Method::PUT,
            &format!("/api/games/{id}/bundle"),
            Some(&other),
            &[Part::File("bundle", "g.zip", "application/zip", &new_zip)],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // Delete removes files.
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{id}"),
            Some(&other),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .send(
            Method::DELETE,
            &format!("/api/games/{id}"),
            Some(&tok),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(!game_dir.exists());
    assert_eq!(
        t.get(&format!("/api/games/{id}"), None).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn list_search_sort() {
    let t = setup().await;
    let (tok, _) = t.register("gina").await;
    let (tok2, _) = t.register("hank").await;
    let a = t
        .create_game(&tok, "Alpha Racer", "racing,arcade", true)
        .await;
    let b = t.create_game(&tok, "Beta Puzzle", "puzzle", true).await;
    let c = t.create_game(&tok2, "Gamma Shooter", "arcade", true).await;
    let _hidden = t.create_game(&tok, "Hidden Racer", "racing", false).await;
    let (aid, bid, cid) = (
        a["id"].as_str().unwrap(),
        b["id"].as_str().unwrap(),
        c["id"].as_str().unwrap(),
    );

    let ids = |v: &serde_json::Value| -> Vec<String> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["id"].as_str().unwrap().to_string())
            .collect()
    };

    // Default: new first, published only.
    let r = t.get("/api/games", None).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["total"], 3);
    assert_eq!(v["page"], 1);
    assert_eq!(v["perPage"], 24);
    assert_eq!(ids(&v), vec![cid, bid, aid]);
    assert!(v["items"][0].get("entry").is_none(), "summary only");

    // Search on title / description / tags.
    let v = t.get("/api/games?q=racer", None).await.json();
    assert_eq!(ids(&v), vec![aid]);
    let v = t.get("/api/games?q=PUZZLE", None).await.json();
    assert_eq!(ids(&v), vec![bid]);
    let v = t.get("/api/games?q=arcad", None).await.json();
    assert_eq!(v["total"], 2);
    let v = t.get("/api/games?q=%25", None).await.json();
    assert_eq!(v["total"], 0, "LIKE wildcards are escaped");

    // Tag & owner filters.
    let v = t.get("/api/games?tag=Arcade", None).await.json();
    assert_eq!(ids(&v), vec![cid, aid]);
    let v = t.get("/api/games?owner=hank", None).await.json();
    assert_eq!(ids(&v), vec![cid]);
    let v = t.get("/api/games?owner=me", Some(&tok)).await.json();
    assert_eq!(v["total"], 3, "owner=me includes unpublished");
    assert_eq!(
        t.get("/api/games?owner=me", None).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Popular.
    for _ in 0..3 {
        let r = t
            .send(
                Method::POST,
                &format!("/api/games/{bid}/play"),
                None,
                None,
                vec![],
                &[],
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let r = t
        .send(
            Method::POST,
            &format!("/api/games/{aid}/play"),
            None,
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.json()["plays"], 1);
    let v = t.get("/api/games?sort=popular", None).await.json();
    assert_eq!(ids(&v), vec![bid, aid, cid]);

    // Top: a (5,5) beats c (4) beats b (1); unrated sorts between by prior.
    for (tk, gid, s) in [
        (&tok, aid, 5),
        (&tok2, aid, 5),
        (&tok, cid, 4),
        (&tok2, bid, 1),
    ] {
        let r = t
            .json(
                Method::PUT,
                &format!("/api/games/{gid}/rating"),
                Some(tk),
                json!({"score": s}),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    let v = t.get("/api/games?sort=top", None).await.json();
    assert_eq!(ids(&v), vec![aid, cid, bid]);

    // Paging.
    let v = t.get("/api/games?perPage=2&page=2", None).await.json();
    assert_eq!(v["perPage"], 2);
    assert_eq!(v["page"], 2);
    assert_eq!(v["items"].as_array().unwrap().len(), 1);
    assert_eq!(v["total"], 3);
    let v = t.get("/api/games?perPage=1000", None).await.json();
    assert_eq!(v["perPage"], 100);
    assert_eq!(
        t.get("/api/games?sort=bogus", None).await.status,
        StatusCode::BAD_REQUEST
    );

    // Tags endpoint counts published games only.
    let v = t.get("/api/tags", None).await.json();
    assert_eq!(v[0], json!({"tag": "arcade", "count": 2}));
    assert!(
        v.as_array()
            .unwrap()
            .contains(&json!({"tag": "racing", "count": 1}))
    );
}

#[tokio::test]
async fn visibility_and_patch_permissions() {
    let t = setup().await;
    let (owner, _) = t.register("ivan").await;
    let (other, _) = t.register("judy").await;
    let hidden = t.create_game(&owner, "Secret", "", false).await;
    let hid = hidden["id"].as_str().unwrap();

    assert_eq!(
        t.get(&format!("/api/games/{hid}"), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get(&format!("/api/games/{hid}"), Some(&other))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let r = t.get(&format!("/api/games/{hid}"), Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["isOwner"], true);
    assert_eq!(
        t.get("/api/games/not-a-uuid", None).await.status,
        StatusCode::NOT_FOUND
    );

    let public = t.create_game(&owner, "Open", "", true).await;
    let pid = public["id"].as_str().unwrap();
    let r = t.get(&format!("/api/games/{pid}"), Some(&other)).await;
    assert_eq!(r.json()["isOwner"], false);

    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{pid}"),
            Some(&other),
            json!({"title": "Hacked"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.error_code(), "forbidden");
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{pid}"),
            None,
            json!({"title": "Hacked"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{pid}"),
            Some(&owner),
            json!({"title": "Renamed", "tags": ["New", "x"], "published": false, "description": "d"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["title"], "Renamed");
    assert_eq!(v["tags"], json!(["new", "x"]));
    assert_eq!(v["published"], false);
    assert_eq!(v["description"], "d");
    let r = t
        .json(
            Method::PATCH,
            &format!("/api/games/{pid}"),
            Some(&owner),
            json!({"title": ""}),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn ratings() {
    let t = setup().await;
    let (a, _) = t.register("kate").await;
    let (b, _) = t.register("liam").await;
    let g = t.create_game(&a, "Rated", "", true).await;
    let id = g["id"].as_str().unwrap();
    let url = format!("/api/games/{id}/rating");

    let r = t
        .json(Method::PUT, &url, Some(&a), json!({"score": 4}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json(),
        json!({"ratingAvg": 4.0, "ratingCount": 1, "myRating": 4})
    );
    let r = t
        .json(Method::PUT, &url, Some(&b), json!({"score": 1}))
        .await;
    assert_eq!(
        r.json(),
        json!({"ratingAvg": 2.5, "ratingCount": 2, "myRating": 1})
    );
    // Re-rating replaces.
    let r = t
        .json(Method::PUT, &url, Some(&b), json!({"score": 2}))
        .await;
    assert_eq!(
        r.json(),
        json!({"ratingAvg": 3.0, "ratingCount": 2, "myRating": 2})
    );

    let v = t.get(&format!("/api/games/{id}"), Some(&b)).await.json();
    assert_eq!(v["myRating"], 2);
    assert_eq!(v["ratingAvg"], 3.0);
    assert_eq!(v["ratingCount"], 2);

    for bad in [
        json!({"score": 0}),
        json!({"score": 6}),
        json!({"score": 2.5}),
        json!({"score": "3"}),
    ] {
        let r = t.json(Method::PUT, &url, Some(&a), bad).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(
        t.json(Method::PUT, &url, None, json!({"score": 3}))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    let r = t
        .send(Method::DELETE, &url, Some(&b), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json(),
        json!({"ratingAvg": 4.0, "ratingCount": 1, "myRating": null})
    );
}

#[tokio::test]
async fn comments_crud_permissions() {
    let t = setup().await;
    let (owner, _) = t.register("mia").await;
    let (author, _) = t.register("noah").await;
    let (stranger, _) = t.register("olga").await;
    let g = t.create_game(&owner, "Commented", "", true).await;
    let id = g["id"].as_str().unwrap();
    let url = format!("/api/games/{id}/comments");

    let r = t
        .json(
            Method::POST,
            &url,
            Some(&author),
            json!({"body": "  first!  "}),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let c1 = r.json();
    assert_eq!(c1["body"], "first!");
    assert_eq!(c1["gameId"], id);
    assert_eq!(c1["author"]["username"], "noah");
    let r = t
        .json(Method::POST, &url, Some(&author), json!({"body": "second"}))
        .await;
    let c2 = r.json();

    assert_eq!(
        t.json(Method::POST, &url, Some(&author), json!({"body": "   "}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        t.json(
            Method::POST,
            &url,
            Some(&author),
            json!({"body": "x".repeat(2001)})
        )
        .await
        .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        t.json(Method::POST, &url, None, json!({"body": "anon"}))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    let v = t.get(&url, None).await.json();
    assert_eq!(v["total"], 2);
    assert_eq!(v["items"][0]["id"], c2["id"], "newest first");
    let v = t.get(&format!("{url}?perPage=1&page=2"), None).await.json();
    assert_eq!(v["items"][0]["id"], c1["id"]);

    let del = |cid: &serde_json::Value| format!("/api/comments/{}", cid["id"].as_str().unwrap());
    let r = t
        .send(
            Method::DELETE,
            &del(&c1),
            Some(&stranger),
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .send(Method::DELETE, &del(&c1), Some(&author), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = t
        .send(Method::DELETE, &del(&c2), Some(&owner), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "game owner can moderate");
    let r = t
        .send(Method::DELETE, &del(&c2), Some(&owner), None, vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&url, None).await.json()["total"], 0);
}

#[tokio::test]
async fn scores_leaderboard_best_per_user() {
    let t = setup().await;
    let (a, _) = t.register("pete").await;
    let (b, _) = t.register("quin").await;
    let (c, _) = t.register("rosa").await;
    let g = t.create_game(&a, "Scored", "", true).await;
    let id = g["id"].as_str().unwrap();
    let url = format!("/api/games/{id}/scores");

    for (tk, s) in [
        (&a, 100.0),
        (&a, 300.0),
        (&a, 200.0),
        (&b, 250.0),
        (&c, 50.0),
        (&c, 250.0),
    ] {
        let r = t
            .json(Method::POST, &url, Some(tk), json!({ "score": s }))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    }
    let r = t
        .json(Method::POST, &url, Some(&b), json!({ "score": 99.0 }))
        .await;
    let v = r.json();
    assert_eq!(v["score"], 99);
    assert_eq!(v["user"]["username"], "quin");
    assert!(v["rank"].as_i64().unwrap() >= 1);

    let v = t.get(&url, None).await.json();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 3, "one row per user");
    assert_eq!(rows[0]["user"]["username"], "pete");
    assert_eq!(rows[0]["score"], 300);
    assert_eq!(rows[0]["rank"], 1);
    // quin and rosa tie on 250: quin submitted first.
    assert_eq!(rows[1]["user"]["username"], "quin");
    assert_eq!(rows[1]["rank"], 2);
    assert_eq!(rows[2]["user"]["username"], "rosa");
    assert_eq!(rows[2]["rank"], 2);

    let v = t.get(&format!("{url}?limit=1"), None).await.json();
    assert_eq!(v.as_array().unwrap().len(), 1);

    assert_eq!(
        t.json(Method::POST, &url, Some(&a), json!({"score": "lots"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        t.json(Method::POST, &url, None, json!({"score": 1}))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn play_page_and_files() {
    let t = setup().await;
    let (owner, _) = t.register("sam").await;
    let g = t.create_game(&owner, "Player", "", true).await;
    let id = g["id"].as_str().unwrap();

    let r = t
        .send(
            Method::GET,
            &format!("/play/{id}?v=1"),
            None,
            None,
            vec![],
            &[("x-forwarded-proto", "https"), ("origin", "null")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.header("content-type").starts_with("text/html"));
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert!(
        r.header("content-security-policy")
            .contains("script-src https://localhost:8080")
    );
    let html = r.text();
    let expected = [
        "<!doctype html><html><head><meta charset=\"utf-8\">".to_string(),
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">".to_string(),
        "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;margin:auto}</style>".to_string(),
        "</head><body><canvas id=\"game\"></canvas>".to_string(),
        "<script type=\"module\">".to_string(),
        "  import { boot } from \"https://localhost:8080/runtime/engine.js\";".to_string(),
        format!("  const base = \"https://localhost:8080/games/{id}/files/\";"),
        "  const mod = await import(base + \"main.js?v=1\");".to_string(),
        "  await boot(document.getElementById(\"game\"), mod.default, { width: 800, height: 600, baseUrl: base });".to_string(),
        "</script></body></html>".to_string(),
        String::new(),
    ]
    .join("
");
    assert_eq!(html, expected);

    // Plain http by default.
    let html = t.get(&format!("/play/{id}"), None).await.text();
    assert!(html.contains("from \"http://localhost:8080/runtime/engine.js\""));

    // Bad Host header is rejected rather than interpolated.
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("host", "evil\"</script>".parse().unwrap());
    assert!(webgame_server::routes::play::request_origin(&headers, 8080).is_err());
    assert_eq!(
        webgame_server::routes::play::js_string_content("a\"</script>"),
        "a\\\"\\u003c/script\\u003e"
    );

    // Unpublished: 404 unless ?token= is an owner preview token (session tokens rejected).
    let hidden = t.create_game(&owner, "Hidden", "", false).await;
    let hid = hidden["id"].as_str().unwrap();
    assert_eq!(
        t.get(&format!("/play/{hid}"), None).await.status,
        StatusCode::NOT_FOUND
    );
    let (other, _) = t.register("tina").await;
    assert_eq!(
        t.get(&format!("/play/{hid}?token={other}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get(&format!("/play/{hid}?token={owner}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Files with MIME types + headers.
    let r = t
        .send(
            Method::GET,
            &format!("/games/{id}/files/main.js"),
            None,
            None,
            vec![],
            &[("origin", "null")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-type"), "text/javascript; charset=utf-8");
    assert_eq!(r.header("cache-control"), "no-cache");
    assert_eq!(r.header("access-control-allow-origin"), "*");
    assert!(r.text().contains("export default"));
    let r = t
        .get(&format!("/games/{id}/files/assets/player.png"), None)
        .await;
    assert_eq!(r.header("content-type"), "image/png");
    let r = t.get(&format!("/games/{id}/files/game.json"), None).await;
    assert!(r.header("content-type").starts_with("application/json"));
    assert_eq!(
        t.get(&format!("/games/{id}/files/nope.js"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get(&format!("/games/{id}/files/..%2F..%2Fwebgame.db"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.get(&format!("/games/{id}/files/assets/../main.js"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Runtime.
    let r = t.get("/runtime/engine.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.header("content-type"), "text/javascript; charset=utf-8");
}

#[tokio::test]
async fn runtime_missing_is_503() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = webgame_server::Config::for_data_dir(dir.path().join("data"));
    config.engine_dist = dir.path().join("missing");
    let state = webgame_server::AppState::new(config).await.unwrap();
    let t = TestApp {
        router: webgame_server::app(state.clone()),
        state,
        dir,
    };
    let r = t.get("/runtime/engine.js", None).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        r.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("build:engine")
    );
}

#[tokio::test]
async fn cors_policies() {
    let t = setup().await;
    let r = t
        .send(
            Method::GET,
            "/api/health",
            None,
            None,
            vec![],
            &[("origin", "http://localhost:5173")],
        )
        .await;
    assert_eq!(
        r.header("access-control-allow-origin"),
        "http://localhost:5173"
    );
    let r = t
        .send(
            Method::GET,
            "/api/health",
            None,
            None,
            vec![],
            &[("origin", "http://evil.example")],
        )
        .await;
    assert_eq!(r.header("access-control-allow-origin"), "");

    // Preflight.
    let r = t
        .send(
            Method::OPTIONS,
            "/api/games",
            None,
            None,
            vec![],
            &[
                ("origin", "tauri://localhost"),
                ("access-control-request-method", "PATCH"),
                (
                    "access-control-request-headers",
                    "authorization,content-type",
                ),
            ],
        )
        .await;
    assert!(r.status.is_success());
    assert_eq!(r.header("access-control-allow-origin"), "tauri://localhost");
    assert!(r.header("access-control-allow-methods").contains("PATCH"));
}

async fn preview_token_for(t: &TestApp, token: &str, gid: &str) -> Resp {
    t.send(
        Method::POST,
        &format!("/api/games/{gid}/preview-token"),
        Some(token),
        None,
        vec![],
        &[],
    )
    .await
}

#[tokio::test]
async fn preview_tokens() {
    let t = setup().await;
    let (owner, owner_id) = t.register("pat").await;
    let (other, _) = t.register("quinn").await;
    let hidden = t.create_game(&owner, "Hidden", "", false).await;
    let hid = hidden["id"].as_str().unwrap();
    let public = t.create_game(&owner, "Public", "", true).await;
    let pid = public["id"].as_str().unwrap();
    let hidden2 = t.create_game(&owner, "Hidden2", "", false).await;
    let hid2 = hidden2["id"].as_str().unwrap();

    // Issue: owner OK, unauthenticated 401, non-owner 403 (visible) / 404 (invisible).
    let r = preview_token_for(&t, &owner, hid).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    let preview = v["token"].as_str().unwrap().to_string();
    let exp = chrono::DateTime::parse_from_rfc3339(v["expiresAt"].as_str().unwrap()).unwrap();
    let secs = exp.timestamp() - chrono::Utc::now().timestamp();
    assert!((590..=600).contains(&secs), "expiresAt {secs}s away");

    let r = t
        .send(
            Method::POST,
            &format!("/api/games/{hid}/preview-token"),
            None,
            None,
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = preview_token_for(&t, &other, pid).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.error_code(), "forbidden");
    let r = preview_token_for(&t, &other, hid).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Claims shape.
    let claims = jsonwebtoken::decode::<serde_json::Value>(
        &preview,
        &jsonwebtoken::DecodingKey::from_secret(t.state.config.jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .unwrap()
    .claims;
    assert_eq!(claims["scope"], "preview");
    assert_eq!(claims["gid"], hid);
    assert_eq!(claims["sub"], owner_id.as_str());

    // /play: preview token for this game → 200; session token → 404; other game's → 404.
    let r = t.get(&format!("/play/{hid}?token={preview}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert!(r.text().contains("/runtime/engine.js"));
    let r = t.get(&format!("/play/{hid}?token={owner}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t.get(&format!("/play/{hid2}?token={preview}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t.get(&format!("/play/{hid}?token=garbage"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Preview tokens never authenticate API calls.
    let r = t.get("/api/auth/me", Some(&preview)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // ...nor count as an optional viewer (unpublished game stays hidden).
    let r = t.get(&format!("/api/games/{hid}"), Some(&preview)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = preview_token_for(&t, &preview, hid).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // The session token still works.
    assert_eq!(
        t.get("/api/auth/me", Some(&owner)).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn spa_fallback_with_web_dist() {
    let dir = tempfile::tempdir().unwrap();
    let web = dir.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>SPA</title>").unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log(1)").unwrap();
    let engine = dir.path().join("engine");
    std::fs::create_dir_all(&engine).unwrap();
    std::fs::write(engine.join("engine.js"), "export function boot() {}").unwrap();
    let mut config = webgame_server::Config::for_data_dir(dir.path().join("data"));
    config.engine_dist = engine;
    config.web_dist = Some(web);
    let state = webgame_server::AppState::new(config).await.unwrap();
    let t = TestApp {
        router: webgame_server::app(state.clone()),
        state,
        dir,
    };

    let (owner, _) = t.register("sam").await;
    let g = t.create_game(&owner, "Spa", "", true).await;
    let id = g["id"].as_str().unwrap();

    for path in [
        "/".to_string(),
        "/browse".to_string(),
        format!("/games/{id}"),
        format!("/games/{id}/edit"),
        "/games/unknown-id".to_string(),
    ] {
        let r = t.get(&path, None).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert!(
            r.text().contains("<title>SPA</title>"),
            "{path}: {}",
            r.text()
        );
    }
    let r = t.get("/assets/app.js", None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.text(), "console.log(1)");

    // Backend-owned routes are not shadowed by the SPA.
    let r = t.get(&format!("/games/{id}/files/main.js"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text().contains("export default"));
    let r = t.get(&format!("/games/{id}/files/missing.js"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(!r.text().contains("SPA"));
    let r = t.get(&format!("/play/{id}"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.text().contains("<canvas"));
    let r = t.get("/api/nope", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.error_code(), "not_found");
}

#[tokio::test]
async fn play_origin_follows_host_header() {
    let t = setup().await;
    let (owner, _) = t.register("uma").await;
    let g = t.create_game(&owner, "Proxied", "", true).await;
    let id = g["id"].as_str().unwrap();
    // The web dev server proxies /play with Host=localhost:5173.
    let r = t
        .send(
            Method::GET,
            &format!("/play/{id}"),
            None,
            None,
            vec![],
            &[("host", "localhost:5173")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(
        r.text()
            .contains(r#"from "http://localhost:5173/runtime/engine.js""#)
    );
}

#[tokio::test]
async fn play_page_uses_public_origin_and_ignores_spoofed_host() {
    let origin =
        webgame_server::config::parse_public_origin("https://arcade.example.com/").unwrap();
    assert_eq!(origin, "https://arcade.example.com");
    let t = setup_with(|c| c.public_origin = Some(origin.clone())).await;
    let (owner, _) = t.register("pubo").await;
    let g = t.create_game(&owner, "Origin", "", true).await;
    let id = g["id"].as_str().unwrap();

    let spoofs: [&[(&str, &str)]; 4] = [
        &[],
        &[("host", "evil.example.net")],
        &[
            ("host", "evil.example.net:6666"),
            ("x-forwarded-proto", "http"),
        ],
        // Even a Host value that would be rejected without PUBLIC_ORIGIN is ignored.
        &[("host", "evil\"</script>")],
    ];
    let mut pages = Vec::new();
    for extra in spoofs {
        let r = t
            .send(
                Method::GET,
                &format!("/play/{id}"),
                None,
                None,
                vec![],
                extra,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{extra:?}: {}", r.text());
        let csp = r.header("content-security-policy");
        assert!(
            csp.contains("script-src https://arcade.example.com "),
            "{csp}"
        );
        assert!(!csp.contains("evil"), "{csp}");
        let html = r.text();
        assert!(html.contains("from \"https://arcade.example.com/runtime/engine.js\""));
        assert!(html.contains(&format!(
            "const base = \"https://arcade.example.com/games/{id}/files/\";"
        )));
        assert!(
            !html.contains("evil") && !html.contains("localhost"),
            "{html}"
        );
        pages.push((html, csp));
    }
    assert!(pages.windows(2).all(|w| w[0] == w[1]));
}
