//! Review 9 backend fixes: L7 (a huge `page` overflowed the `OFFSET` arithmetic).

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;
use webgame_server::routes::games::{MAX_PAGE, page_offset, parse_paging};

/// `i64::MAX`, and `2^62 + 1`, which with `perPage=12` used to wrap the offset to exactly 0
/// in release builds (so page 1's items came back).
const HUGE_PAGES: [&str; 2] = ["9223372036854775807", "4611686018427387905"];

#[test]
fn l7_paging_caps_page_and_offset_never_overflows() {
    assert_eq!(
        parse_paging(Some("9223372036854775807"), Some("100"), 24).unwrap(),
        (MAX_PAGE, 100)
    );
    assert_eq!(
        parse_paging(Some("-9223372036854775808"), None, 24).unwrap(),
        (1, 24)
    );
    assert_eq!(parse_paging(Some("7"), None, 24).unwrap(), (7, 24));
    // Too large for i64 at all → still the existing 400 message.
    let err = parse_paging(Some("9223372036854775808"), None, 24).unwrap_err();
    assert!(err.to_string().contains("page must be an integer"), "{err}");

    assert_eq!(page_offset(1, 24), 0);
    assert_eq!(page_offset(3, 24), 48);
    assert_eq!(page_offset(MAX_PAGE, 100), (MAX_PAGE - 1) * 100);
    assert_eq!(page_offset(i64::MAX, 100), i64::MAX);
    assert_eq!(page_offset(i64::MIN, 100), 0);
}

#[tokio::test]
async fn l7_huge_page_is_clamped_on_paged_endpoints() {
    let t = setup().await;
    let (owner, _) = t.register("olga").await;
    let (fan, _) = t.register("fan").await;
    let g = t.create_game(&owner, "Paged", "", true).await;
    let gid = g["id"].as_str().unwrap().to_string();
    let r = t
        .json(
            Method::POST,
            &format!("/api/games/{gid}/comments"),
            Some(&fan),
            json!({ "body": "hello" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());

    // Each endpoint has at least one row on page 1, so a wrapped offset would show it.
    let endpoints = [
        ("/api/games".to_string(), 1),
        (format!("/api/games/{gid}/comments"), 1),
        (format!("/api/games/{gid}/versions"), 1),
        (format!("/api/games/{gid}/screenshots"), 0),
        ("/api/users/olga/screenshots".to_string(), 0),
        ("/api/users/olga/collections".to_string(), 0),
        ("/api/users/fan/followers".to_string(), 0),
    ];
    for (base, total) in &endpoints {
        // Page 1 sanity check: the rows really are there.
        let r = t.get(&format!("{base}?perPage=12"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{base}: {}", r.text());
        assert_eq!(r.json()["total"], *total, "{base}");
        assert_eq!(
            r.json()["items"].as_array().unwrap().len(),
            *total,
            "{base}"
        );

        for huge in HUGE_PAGES {
            let uri = format!("{base}?page={huge}&perPage=12");
            let r = t.get(&uri, None).await;
            assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.text());
            let body = r.json();
            assert_eq!(body["page"], MAX_PAGE, "{uri}");
            assert_eq!(body["total"], *total, "{uri}");
            assert!(
                body["items"].as_array().unwrap().is_empty(),
                "{uri}: {body}"
            );
        }
    }

    // Signed-in lists go through the same paging.
    let r = t
        .get(
            "/api/users/me/favorites?page=9223372036854775807",
            Some(&fan),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["page"], MAX_PAGE);

    // A value that isn't an i64 is still a 400 with the documented message.
    let r = t
        .get(
            &format!("/api/users/olga/screenshots?page=1{}", "0".repeat(30)),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["error"]["message"], "page must be an integer");
}
