//! F001 Leaderboards 2.0 (docs/features/F001-leaderboards-2.md, API.md § F001).

mod common;

use axum::http::{Method, StatusCode};
use chrono::{Datelike, Utc};
use common::*;
use serde_json::{Value, json};
use webgame_server::routes::scores::{Period, period_bounds};

fn bundle_with(game_json: &str) -> Vec<u8> {
    make_zip(&[
        ("game.json", game_json.as_bytes()),
        ("main.js", b"export default { update() {}, render() {} };"),
    ])
}

fn manifest(leaderboard: Option<Value>) -> String {
    let mut v = json!({ "name": "LB", "entry": "main.js", "width": 320, "height": 240 });
    if let Some(lb) = leaderboard {
        v["leaderboard"] = lb;
    }
    v.to_string()
}

async fn upload(t: &TestApp, token: &str, game_json: &str, published: bool) -> Resp {
    let zip = bundle_with(game_json);
    t.multipart(
        Method::POST,
        "/api/games",
        Some(token),
        &[
            Part::Text("title", "LB game"),
            Part::Text("published", if published { "true" } else { "false" }),
            Part::File("bundle", "game.zip", "application/zip", &zip),
        ],
    )
    .await
}

/// Create a game with the given `leaderboard` block; returns its id.
async fn game_with(t: &TestApp, token: &str, lb: Option<Value>, published: bool) -> String {
    let r = upload(t, token, &manifest(lb), published).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

async fn submit(t: &TestApp, token: &str, gid: &str, score: f64) -> Resp {
    t.json(
        Method::POST,
        &format!("/api/games/{gid}/scores"),
        Some(token),
        json!({ "score": score }),
    )
    .await
}

async fn submit_ok(t: &TestApp, token: &str, gid: &str, score: f64) -> Value {
    let r = submit(t, token, gid, score).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
    r.json()
}

async fn insert_score(t: &TestApp, gid: &str, uid: &str, score: i64, created_at: &str) {
    sqlx::query(
        "INSERT INTO scores (id, game_id, user_id, score, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(gid)
    .bind(uid)
    .bind(score)
    .bind(created_at)
    .execute(&t.state.db)
    .await
    .unwrap();
}

fn rfc(dt: chrono::DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse(s: &str) -> chrono::DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(s).unwrap().into()
}

fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["user"]["username"].as_str().unwrap().to_string())
        .collect()
}

fn scores_of(list: &Value) -> Vec<i64> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["score"].as_i64().unwrap())
        .collect()
}

fn ranks_of(list: &Value) -> Vec<i64> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["rank"].as_i64().unwrap())
        .collect()
}

// ---------------------------------------------------------------------------
// game.json validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn game_json_leaderboard_validation_and_defaults() {
    let t = setup().await;
    let (tok, _) = t.register("creator").await;

    let bad = [
        json!("asc"),
        json!([1]),
        json!({ "order": "up" }),
        json!({ "order": 1 }),
        json!({ "format": "seconds" }),
        json!({ "format": true }),
        json!({ "label": 5 }),
        json!({ "label": "x".repeat(25) }),
    ];
    for lb in bad {
        let r = upload(&t, &tok, &manifest(Some(lb.clone())), true).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{lb}: {}",
            r.text()
        );
        assert_eq!(r.error_code(), "validation");
    }

    // Absent block → defaults.
    let gid = game_with(&t, &tok, None, true).await;
    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(
        g["leaderboard"],
        json!({ "order": "desc", "format": "number", "label": "" })
    );

    // Partial block: missing keys default, unknown keys ignored, label trimmed (24 chars ok).
    let gid2 = game_with(
        &t,
        &tok,
        Some(json!({ "order": "asc", "label": format!("  {}  ", "y".repeat(24)), "extra": 1 })),
        true,
    )
    .await;
    let g = t.get(&format!("/api/games/{gid2}"), None).await.json();
    assert_eq!(
        g["leaderboard"],
        json!({ "order": "asc", "format": "number", "label": "y".repeat(24) })
    );

    // Bundle replace updates the values; an invalid block is rejected there too.
    let replace = |gj: String| {
        let t = &t;
        let tok = &tok;
        let gid = gid.clone();
        async move {
            let zip = bundle_with(&gj);
            t.multipart(
                Method::PUT,
                &format!("/api/games/{gid}/bundle"),
                Some(tok),
                &[Part::File("bundle", "game.zip", "application/zip", &zip)],
            )
            .await
        }
    };
    let r = replace(manifest(Some(
        json!({ "order": "asc", "format": "time", "label": "Best time" }),
    )))
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.json()["leaderboard"],
        json!({ "order": "asc", "format": "time", "label": "Best time" })
    );
    let r = replace(manifest(Some(json!({ "format": "hours" })))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let g = t.get(&format!("/api/games/{gid}"), None).await.json();
    assert_eq!(g["leaderboard"]["format"], "time");
    // Replacing with no block resets to defaults.
    let r = replace(manifest(None)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json()["leaderboard"],
        json!({ "order": "desc", "format": "number", "label": "" })
    );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

#[tokio::test]
async fn asc_ordering_on_both_endpoints() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    let (c, _) = t.register("carol").await;
    let gid = game_with(
        &t,
        &owner,
        Some(json!({ "order": "asc", "format": "time" })),
        true,
    )
    .await;

    submit_ok(&t, &a, &gid, 3000.0).await;
    submit_ok(&t, &a, &gid, 2500.0).await; // alice's best is the minimum
    submit_ok(&t, &a, &gid, 4000.0).await;
    submit_ok(&t, &b, &gid, 2500.0).await; // ties alice, but later
    submit_ok(&t, &c, &gid, 1200.0).await;

    let r = t.get(&format!("/api/games/{gid}/scores"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    let list = r.json();
    assert_eq!(names(&list), ["carol", "alice", "bob"]);
    assert_eq!(scores_of(&list), [1200, 2500, 2500]);
    assert_eq!(ranks_of(&list), [1, 2, 2]);

    let lb = t
        .get(&format!("/api/games/{gid}/leaderboard"), None)
        .await
        .json();
    assert_eq!(lb["period"], "all");
    assert!(lb["periodStart"].is_null() && lb["periodEnd"].is_null());
    assert_eq!(
        lb["config"],
        json!({ "order": "asc", "format": "time", "label": "" })
    );
    assert_eq!(names(&lb["entries"]), ["carol", "alice", "bob"]);
    assert_eq!(ranks_of(&lb["entries"]), [1, 2, 2]);
    assert_eq!(lb["totalPlayers"], 3);
    assert!(lb["me"].is_null());

    // Desc games keep v1 semantics.
    let gid2 = game_with(&t, &owner, None, true).await;
    submit_ok(&t, &a, &gid2, 10.0).await;
    submit_ok(&t, &b, &gid2, 30.0).await;
    submit_ok(&t, &a, &gid2, 20.0).await;
    let list = t
        .get(&format!("/api/games/{gid2}/scores?limit=5"), None)
        .await
        .json();
    assert_eq!(names(&list), ["bob", "alice"]);
    assert_eq!(scores_of(&list), [30, 20]);
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

#[test]
fn period_bounds_are_utc_day_and_iso_week() {
    // 2026-11-14 is a Saturday.
    let now = parse("2026-11-14T13:45:00.123Z");
    assert_eq!(period_bounds(Period::All, now), None);
    assert_eq!(
        period_bounds(Period::Day, now),
        Some((
            "2026-11-14T00:00:00.000Z".into(),
            "2026-11-15T00:00:00.000Z".into()
        ))
    );
    assert_eq!(
        period_bounds(Period::Week, now),
        Some((
            "2026-11-09T00:00:00.000Z".into(),
            "2026-11-16T00:00:00.000Z".into()
        ))
    );
    // Monday 00:00 starts its own week; Sunday belongs to the previous one.
    let monday = parse("2026-11-16T00:00:00.000Z");
    assert_eq!(
        period_bounds(Period::Week, monday).unwrap().0,
        "2026-11-16T00:00:00.000Z"
    );
    let sunday = parse("2026-11-15T23:59:59.999Z");
    assert_eq!(
        period_bounds(Period::Week, sunday).unwrap().0,
        "2026-11-09T00:00:00.000Z"
    );
    // Year boundary.
    let ny = parse("2027-01-01T08:00:00.000Z");
    assert_eq!(
        period_bounds(Period::Week, ny),
        Some((
            "2026-12-28T00:00:00.000Z".into(),
            "2027-01-04T00:00:00.000Z".into()
        ))
    );
}

#[tokio::test]
async fn period_filtering() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (_, w_id) = t.register("weekstart").await;
    let (_, o_id) = t.register("lastweek").await;
    let (_, f_id) = t.register("future").await;
    let (n_tok, _) = t.register("nowuser").await;
    let gid = game_with(&t, &owner, None, true).await;

    let now = Utc::now();
    let (day_start, day_end) = period_bounds(Period::Day, now).unwrap();
    let (week_start, week_end) = period_bounds(Period::Week, now).unwrap();
    let is_monday = now.weekday() == chrono::Weekday::Mon;

    // Exactly at the week start (inclusive).
    insert_score(&t, &gid, &w_id, 300, &week_start).await;
    // One millisecond before the week start: only in "all".
    let before_week = rfc(parse(&week_start) - chrono::Duration::milliseconds(1));
    insert_score(&t, &gid, &o_id, 900, &before_week).await;
    // At the (exclusive) day end: not in today's board, but in the week unless the week ends then.
    insert_score(&t, &gid, &f_id, 500, &day_end).await;
    // Now, through the API.
    submit_ok(&t, &n_tok, &gid, 100.0).await;

    let lb = |period: &'static str| {
        let t = &t;
        let gid = gid.clone();
        async move {
            let r = t
                .get(
                    &format!("/api/games/{gid}/leaderboard?period={period}&limit=10"),
                    None,
                )
                .await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.text());
            r.json()
        }
    };

    let day = lb("day").await;
    assert_eq!(day["period"], "day");
    assert_eq!(day["periodStart"], json!(day_start));
    assert_eq!(day["periodEnd"], json!(day_end));
    let mut expect_day = vec!["nowuser"];
    if is_monday {
        expect_day.insert(0, "weekstart");
    }
    assert_eq!(names(&day["entries"]), expect_day);
    assert_eq!(day["totalPlayers"], expect_day.len());

    let week = lb("week").await;
    assert_eq!(week["periodStart"], json!(week_start));
    assert_eq!(week["periodEnd"], json!(week_end));
    let mut expect_week = vec!["weekstart", "nowuser"];
    if day_end != week_end {
        expect_week.insert(0, "future"); // 500 beats 300
    }
    assert_eq!(names(&week["entries"]), expect_week);
    assert_eq!(week["totalPlayers"], expect_week.len());

    let all = lb("all").await;
    assert_eq!(
        names(&all["entries"]),
        ["lastweek", "future", "weekstart", "nowuser"]
    );
    assert_eq!(all["totalPlayers"], 4);

    // /scores honours period the same way.
    let list = t
        .get(&format!("/api/games/{gid}/scores?period=week"), None)
        .await
        .json();
    assert_eq!(names(&list), expect_week);
    let list = t
        .get(&format!("/api/games/{gid}/scores?period=all"), None)
        .await
        .json();
    assert_eq!(names(&list), names(&all["entries"]));

    // A user's window best ignores their better score outside the window.
    insert_score(&t, &gid, &w_id, 5000, &before_week).await;
    let week = lb("week").await;
    let ws = week["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["user"]["username"] == "weekstart")
        .unwrap()
        .clone();
    assert_eq!(ws["score"], 300);
    let all = lb("all").await;
    assert_eq!(all["entries"][0]["user"]["username"], "weekstart");
    assert_eq!(all["entries"][0]["score"], 5000);
}

// ---------------------------------------------------------------------------
// me
// ---------------------------------------------------------------------------

#[tokio::test]
async fn me_outside_top_n() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (a, _) = t.register("alice").await;
    let (b, _) = t.register("bob").await;
    let (c, c_id) = t.register("carol").await;
    let gid = game_with(&t, &owner, None, true).await;
    submit_ok(&t, &a, &gid, 300.0).await;
    submit_ok(&t, &b, &gid, 200.0).await;
    submit_ok(&t, &c, &gid, 100.0).await;

    let url = format!("/api/games/{gid}/leaderboard?period=week&limit=2");
    let lb = t.get(&url, Some(&c)).await.json();
    assert_eq!(names(&lb["entries"]), ["alice", "bob"]);
    assert_eq!(lb["totalPlayers"], 3);
    assert_eq!(lb["me"]["user"]["id"], json!(c_id));
    assert_eq!(lb["me"]["score"], 100);
    assert_eq!(lb["me"]["rank"], 3);

    // Inside the top N, `me` is still set.
    let lb = t.get(&url, Some(&a)).await.json();
    assert_eq!(lb["me"]["rank"], 1);
    assert_eq!(lb["me"]["user"]["username"], "alice");

    // Anonymous, or a viewer without scores → null.
    assert!(t.get(&url, None).await.json()["me"].is_null());
    assert!(t.get(&url, Some(&owner)).await.json()["me"].is_null());

    // Limit is clamped to 1..=100.
    let lb = t
        .get(&format!("/api/games/{gid}/leaderboard?limit=0"), None)
        .await
        .json();
    assert_eq!(lb["entries"].as_array().unwrap().len(), 1);
    let lb = t
        .get(&format!("/api/games/{gid}/leaderboard?limit=1000"), None)
        .await
        .json();
    assert_eq!(lb["entries"].as_array().unwrap().len(), 3);
}

// ---------------------------------------------------------------------------
// Submit result
// ---------------------------------------------------------------------------

#[tokio::test]
async fn personal_best_flags() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (a, a_id) = t.register("alice").await;
    let desc = game_with(&t, &owner, None, true).await;

    let r = submit_ok(&t, &a, &desc, 100.0).await;
    assert_eq!(r["personalBest"], true, "first score");
    // Superset of v1 Score.
    assert!(r["id"].is_string());
    assert_eq!(r["user"]["id"], json!(a_id));
    assert_eq!(r["score"], 100);
    assert!(r["createdAt"].is_string());
    assert_eq!(r["rank"], 1);
    assert_eq!(submit_ok(&t, &a, &desc, 50.0).await["personalBest"], false);
    assert_eq!(submit_ok(&t, &a, &desc, 100.0).await["personalBest"], false);
    assert_eq!(submit_ok(&t, &a, &desc, 101.0).await["personalBest"], true);

    let asc = game_with(&t, &owner, Some(json!({ "order": "asc" })), true).await;
    assert_eq!(submit_ok(&t, &a, &asc, 100.0).await["personalBest"], true);
    assert_eq!(submit_ok(&t, &a, &asc, 150.0).await["personalBest"], false);
    assert_eq!(submit_ok(&t, &a, &asc, 100.0).await["personalBest"], false);
    assert_eq!(submit_ok(&t, &a, &asc, 99.0).await["personalBest"], true);
}

#[tokio::test]
async fn ranks_per_period() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (_, old_id) = t.register("veteran").await;
    let (b, _) = t.register("bob").await;
    let (c, _) = t.register("carol").await;
    let gid = game_with(&t, &owner, None, true).await;

    let (week_start, _) = period_bounds(Period::Week, Utc::now()).unwrap();
    let long_ago = rfc(parse(&week_start) - chrono::Duration::days(3));
    insert_score(&t, &gid, &old_id, 1000, &long_ago).await;

    let r = submit_ok(&t, &b, &gid, 500.0).await;
    assert_eq!(r["ranks"], json!({ "day": 1, "week": 1, "all": 2 }));
    assert_eq!(r["rank"], 2);

    let r = submit_ok(&t, &c, &gid, 700.0).await;
    assert_eq!(r["ranks"], json!({ "day": 1, "week": 1, "all": 2 }));
    assert_eq!(r["rank"], 2);

    // A lower score: v1 rank is this score's rank, ranks are of the user's best.
    let r = submit_ok(&t, &b, &gid, 100.0).await;
    assert_eq!(r["personalBest"], false);
    assert_eq!(r["rank"], 3); // veteran 1000 and carol 700 are better
    assert_eq!(r["ranks"], json!({ "day": 2, "week": 2, "all": 3 }));

    // Ties share a rank (competition ranking).
    let r = submit_ok(&t, &b, &gid, 700.0).await;
    assert_eq!(r["personalBest"], true);
    assert_eq!(r["ranks"], json!({ "day": 1, "week": 1, "all": 2 }));
    assert_eq!(r["rank"], 2);
}

#[tokio::test]
async fn time_format_range() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (a, _) = t.register("alice").await;
    let gid = game_with(
        &t,
        &owner,
        Some(json!({ "format": "time", "order": "asc" })),
        true,
    )
    .await;

    for bad in [-1.0, 86_400_001.0, 1e12] {
        let r = submit(&t, &a, &gid, bad).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_eq!(r.error_code(), "validation");
    }
    for ok in [0.0, 86_400_000.0, 83_456.0] {
        submit_ok(&t, &a, &gid, ok).await;
    }

    // Number games are unrestricted (as in v1).
    let num = game_with(&t, &owner, None, true).await;
    submit_ok(&t, &a, &num, -5.0).await;
    submit_ok(&t, &a, &num, 1e12).await;
}

// ---------------------------------------------------------------------------
// Errors, visibility, rate limit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn bad_query_params() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let gid = game_with(&t, &owner, None, true).await;
    for path in ["leaderboard", "scores"] {
        for q in ["period=bogus", "period=DAY", "limit=abc", "limit=1.5"] {
            let r = t.get(&format!("/api/games/{gid}/{path}?{q}"), None).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{path}?{q}");
            assert_eq!(r.error_code(), "bad_request");
        }
    }
}

#[tokio::test]
async fn unpublished_game_is_404_for_non_owners() {
    let t = setup().await;
    let (owner, _) = t.register("owner").await;
    let (other, _) = t.register("other").await;
    let gid = game_with(&t, &owner, None, false).await;
    let url = format!("/api/games/{gid}/leaderboard");
    assert_eq!(t.get(&url, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        t.get(&url, Some(&other)).await.status,
        StatusCode::NOT_FOUND
    );
    let r = t.get(&url, Some(&owner)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["totalPlayers"], 0);
    assert_eq!(r.json()["entries"], json!([]));
    let missing = "/api/games/00000000-0000-4000-8000-000000000000/leaderboard";
    assert_eq!(t.get(missing, None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn leaderboard_rate_limit() {
    let t = setup_with(|c| c.rate_limit = true).await;
    let (owner, _) = t.register("owner").await;
    let (a, _) = t.register("alice").await;
    let gid = game_with(&t, &owner, None, true).await;
    let url = format!("/api/games/{gid}/leaderboard");

    // Anonymous: per IP.
    for i in 0..120 {
        assert_eq!(t.get(&url, None).await.status, StatusCode::OK, "#{i}");
    }
    let r = t.get(&url, None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.error_code(), "rate_limited");
    assert!(!r.header("retry-after").is_empty());

    // Authenticated users have their own bucket.
    assert_eq!(t.get(&url, Some(&a)).await.status, StatusCode::OK);

    // /scores is not limited by the leaderboard bucket.
    let scores = format!("/api/games/{gid}/scores");
    for _ in 0..5 {
        assert_eq!(t.get(&scores, None).await.status, StatusCode::OK);
    }
}
