//! /api/users/*

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiMultipart, ApiPath, ApiQuery};
use crate::models::{
    GAME_SELECT, GameSummary, ProfileLink, USER_COLUMNS, User, game_row_from_row, user_from_row,
};
use crate::ratelimit::Limit;
use crate::routes::auth::load_user;
use crate::routes::collections::USER_COLLECTIONS_FILTER;
use crate::routes::follows::{follow_counts, is_following};
use crate::routes::games::limit_user;
use crate::routes::games::{page_offset, parse_paging};
use crate::routes::screenshots::{busy, user_screenshots_count_sql};
use crate::screenshots::process_banner;
use crate::storage::validate_image;

/// F028: profile totals for the viewer; each equals its list endpoint's total.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    /// Sum of `plays` over the games counted in `games_total`.
    pub plays: i64,
    /// Rows `GET /api/users/{u}/achievements` could return (no limit).
    pub achievements: i64,
    /// `total` of `GET /api/users/{u}/screenshots` for the same viewer.
    pub screenshots: i64,
    /// `total` of `GET /api/users/{u}/collections` for the same viewer.
    pub collections: i64,
    /// F030: the user's posts (all public).
    pub posts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub user: User,
    /// One page of the user's games, newest first (`?page=&perPage=`, default 24, max 100).
    pub games: Vec<GameSummary>,
    /// Number of the user's games visible to the viewer (all pages).
    pub games_total: i64,
    /// F002: users following this user.
    pub followers: i64,
    /// F002: users this user follows.
    pub following: i64,
    /// F002: the viewer follows this user (false when anonymous or viewing yourself).
    pub is_following: bool,
    /// F028: profile totals for this viewer.
    pub stats: ProfileStats,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileQuery {
    pub page: Option<String>,
    pub per_page: Option<String>,
}

pub async fn get_user(
    State(state): State<AppState>,
    viewer: MaybeAuthUser,
    ApiPath(username): ApiPath<String>,
    ApiQuery(query): ApiQuery<ProfileQuery>,
) -> AppResult<Json<UserProfile>> {
    let (page, per_page) = parse_paging(query.page.as_deref(), query.per_page.as_deref(), 24)?;
    let row = sqlx::query(&format!(
        "SELECT {USER_COLUMNS} FROM users WHERE username_lower = ?"
    ))
    .bind(username.to_ascii_lowercase())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("User"))?;
    let user = user_from_row(&row)?;
    let id = user.user_ref.id.clone();
    let is_me = viewer.id() == Some(id.as_str());
    let filter = if is_me { "" } else { "AND g.published = 1" };
    let sql = format!(
        "{GAME_SELECT} WHERE g.owner_id = ? {filter} ORDER BY g.created_at DESC, g.id \
         LIMIT ? OFFSET ?"
    );
    let rows = sqlx::query(&sql)
        .bind(&id)
        .bind(per_page)
        .bind(page_offset(page, per_page))
        .fetch_all(&state.db)
        .await?;
    let games = rows
        .iter()
        .map(|r| game_row_from_row(r).map(|g| g.summary()))
        .collect::<Result<Vec<_>, _>>()?;
    let games_total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM games g WHERE g.owner_id = ? {filter}"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let (followers, following) = follow_counts(&state.db, &id).await?;
    let is_following = match viewer.id() {
        Some(v) if !is_me => is_following(&state.db, v, &id).await?,
        _ => false,
    };
    let stats = profile_stats(&state, &id, viewer.id(), filter).await?;
    Ok(Json(UserProfile {
        user,
        games,
        games_total,
        followers,
        following,
        is_following,
        stats,
    }))
}

/// F028: the four profile totals (ARCHITECTURE § F028 "Stats"). `filter` is the games filter
/// of `games_total` (`""` for the owner, `AND g.published = 1` otherwise).
async fn profile_stats(
    state: &AppState,
    user_id: &str,
    viewer: Option<&str>,
    filter: &str,
) -> AppResult<ProfileStats> {
    let plays: i64 = sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(g.plays), 0) FROM games g WHERE g.owner_id = ?1 {filter}"
    ))
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let achievements: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_achievements ua \
         JOIN achievements a ON a.game_id = ua.game_id AND a.ach_id = ua.ach_id \
         JOIN games g ON g.id = ua.game_id \
         WHERE ua.user_id = ?1 AND (g.published = 1 OR g.owner_id = ?2)",
    )
    .bind(user_id)
    .bind(viewer)
    .fetch_one(&state.db)
    .await?;
    let screenshots: i64 = sqlx::query_scalar(&user_screenshots_count_sql())
        .bind(user_id)
        .bind(viewer)
        .fetch_one(&state.db)
        .await?;
    let is_self = viewer == Some(user_id);
    let collections: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM collections c WHERE {USER_COLLECTIONS_FILTER}"
    ))
    .bind(user_id)
    .bind(viewer)
    .bind(is_self)
    .fetch_one(&state.db)
    .await?;
    let posts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM posts WHERE author_id = ?1")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(ProfileStats {
        plays,
        achievements,
        screenshots,
        collections,
        posts,
    })
}

/// F028: one item of `UpdateMeRequest.links`. Missing fields count as `""`; unknown keys are
/// ignored.
#[derive(Debug, Default, Deserialize)]
pub struct LinkBody {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeBody {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    /// F028: omitted or null = unchanged; `[]` = clear.
    pub links: Option<Vec<LinkBody>>,
}

pub const DISPLAY_NAME_MAX: usize = 50;
pub const BIO_MAX: usize = 1000;
/// F028 link limits (API § F028 "Link rules"; mirrored by the client's `profile.ts`).
pub const LINKS_MAX: usize = 3;
pub const LINK_LABEL_MAX: usize = 30;
pub const LINK_URL_MAX: usize = 200;

/// F028: the URL format rule of API § F028 on a trimmed value. Returns the stored form (the
/// scheme lowercased) or `None`.
fn normalize_link_url(url: &str) -> Option<String> {
    // 1. Printable ASCII only (so byte slicing below is on char boundaries).
    if url.is_empty() || !url.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return None;
    }
    // 2. Scheme, case-insensitive.
    let (scheme, rest) = ["http://", "https://"].iter().find_map(|s| {
        let head = url.get(..s.len())?;
        head.eq_ignore_ascii_case(s).then(|| (*s, &url[s.len()..]))
    })?;
    // 3. Authority: up to the first '/', '?' or '#'.
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return None;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let host_ok = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && host.contains('.')
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-']);
    let port_ok =
        port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    // 4. The rest is only bound by rule 1.
    (host_ok && port_ok).then(|| format!("{scheme}{rest}"))
}

/// F028: characters a link label may not contain: C0 controls, DEL, C1 controls, and the bidi
/// and invisible formatting characters that can make a label display as different text.
pub(crate) fn is_forbidden_label_char(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1F}'
            | '\u{7F}'..='\u{9F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// F028: validate `PATCH /api/users/me` `links` (API § F028 "Link rules"; the first failure
/// wins). Returns the links to store: labels trimmed, URLs trimmed with the scheme lowercased.
pub fn validate_links(input: Vec<LinkBody>) -> Result<Vec<ProfileLink>, AppError> {
    if input.len() > LINKS_MAX {
        return Err(AppError::validation(format!(
            "links must have at most {LINKS_MAX} items"
        )));
    }
    let mut out = Vec::with_capacity(input.len());
    for (i, link) in input.into_iter().enumerate() {
        let label = link.label.trim();
        if label.chars().any(is_forbidden_label_char) {
            return Err(AppError::validation(format!(
                "links[{i}].label must not contain control characters"
            )));
        }
        if label.chars().count() > LINK_LABEL_MAX {
            return Err(AppError::validation(format!(
                "links[{i}].label must be at most {LINK_LABEL_MAX} characters"
            )));
        }
        let url = link.url.trim();
        if url.chars().count() > LINK_URL_MAX {
            return Err(AppError::validation(format!(
                "links[{i}].url must be at most {LINK_URL_MAX} characters"
            )));
        }
        let url = normalize_link_url(url).ok_or_else(|| {
            AppError::validation(format!(
                "links[{i}].url must be a full http:// or https:// address"
            ))
        })?;
        out.push(ProfileLink {
            label: label.to_string(),
            url,
        });
    }
    Ok(out)
}

/// `PATCH /api/users/me`. F028: every present field is validated (displayName, bio, links)
/// before anything is written, then all of them are written in one statement.
pub async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<UpdateMeBody>,
) -> AppResult<Json<User>> {
    let display_name = match body.display_name {
        Some(name) => {
            let name = name.trim().to_string();
            let len = name.chars().count();
            if len == 0 || len > DISPLAY_NAME_MAX {
                return Err(AppError::validation(format!(
                    "displayName must be 1-{DISPLAY_NAME_MAX} characters"
                )));
            }
            Some(name)
        }
        None => None,
    };
    let bio = match body.bio {
        Some(bio) => {
            let bio = bio.trim().to_string();
            if bio.chars().count() > BIO_MAX {
                return Err(AppError::validation(format!(
                    "bio must be at most {BIO_MAX} characters"
                )));
            }
            Some(bio)
        }
        None => None,
    };
    let links_json = match body.links {
        Some(links) => Some(
            serde_json::to_string(&validate_links(links)?)
                .map_err(|e| AppError::Internal(format!("links json: {e}")))?,
        ),
        None => None,
    };
    if display_name.is_some() || bio.is_some() || links_json.is_some() {
        // One statement: all present fields change together or not at all.
        sqlx::query(
            "UPDATE users SET display_name = COALESCE(?1, display_name), \
             bio = COALESCE(?2, bio), links_json = COALESCE(?3, links_json) WHERE id = ?4",
        )
        .bind(&display_name)
        .bind(&bio)
        .bind(&links_json)
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(load_user(&state, &user.id).await?))
}

pub async fn upload_avatar(
    State(state): State<AppState>,
    user: AuthUser,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Json<User>> {
    limit_user(&state, Limit::Image, &user.id)?;
    let mut avatar = None;
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("avatar") {
            avatar = Some(field.bytes().await?);
        }
    }
    let bytes = avatar.ok_or_else(|| AppError::validation("avatar file is required"))?;
    let ext = validate_image(&bytes, "avatar")?;
    let dir = state.storage.avatars_dir();
    state
        .storage
        .replace_image(&dir, &user.id, ext, &bytes)
        .await?;
    sqlx::query(
        "UPDATE users SET avatar_ext = ?, avatar_version = avatar_version + 1 WHERE id = ?",
    )
    .bind(ext)
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    Ok(Json(load_user(&state, &user.id).await?))
}

/// F028 `PUT /api/users/me/banner`: decode, crop to 3:1, re-encode as JPEG and store as
/// `banners/{userId}.jpg`.
pub async fn upload_banner(
    State(state): State<AppState>,
    user: AuthUser,
    ApiMultipart(mut multipart): ApiMultipart,
) -> AppResult<Response> {
    limit_user(&state, Limit::Image, &user.id)?;
    let mut banner = None;
    while let Some(field) = multipart.next_field().await? {
        if field.name() == Some("banner") {
            banner = Some(field.bytes().await?);
        }
    }
    let bytes = banner.ok_or_else(|| AppError::validation("banner file is required"))?;
    validate_image(&bytes, "banner")?;
    let Ok(permit) = state.image_slots.clone().try_acquire_owned() else {
        // Not the client's fault: give the `Limit::Image` token back (as screenshots do).
        state
            .limiter
            .refund(Limit::Image, &format!("user:{}", user.id));
        return Ok(busy());
    };
    let jpeg = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        process_banner(&bytes)
    })
    .await
    .map_err(|e| AppError::Internal(format!("banner task: {e}")))??;
    let dir = state.storage.banners_dir();
    state
        .storage
        .replace_image(&dir, &user.id, "jpg", &jpeg)
        .await?;
    sqlx::query(
        "UPDATE users SET banner_ext = 'jpg', banner_version = banner_version + 1 WHERE id = ?",
    )
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    Ok(Json(load_user(&state, &user.id).await?).into_response())
}

/// F028 `DELETE /api/users/me/banner`: idempotent; the version only increases when a banner
/// was removed.
pub async fn delete_banner(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<User>> {
    sqlx::query(
        "UPDATE users SET banner_ext = NULL, banner_version = banner_version + 1 \
         WHERE id = ? AND banner_ext IS NOT NULL",
    )
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    state
        .storage
        .remove_images(&state.storage.banners_dir(), &user.id)
        .await;
    Ok(Json(load_user(&state, &user.id).await?))
}

/// F028 admin `clearProfile`: display name ← username, bio and links emptied, avatar and banner
/// removed (versions + 1, files deleted). Content stays. An unknown id is a no-op.
pub async fn clear_profile(state: &AppState, user_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE users SET display_name = username, bio = '', links_json = '[]', \
         avatar_ext = NULL, avatar_version = avatar_version + 1, \
         banner_ext = NULL, banner_version = banner_version + 1 WHERE id = ?",
    )
    .bind(user_id)
    .execute(&state.db)
    .await?;
    state
        .storage
        .remove_images(&state.storage.avatars_dir(), user_id)
        .await;
    state
        .storage
        .remove_images(&state.storage.banners_dir(), user_id)
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(label: &str, url: &str) -> LinkBody {
        LinkBody {
            label: label.into(),
            url: url.into(),
        }
    }

    fn err(input: Vec<LinkBody>) -> String {
        match validate_links(input).unwrap_err() {
            AppError::Validation(m) => m,
            other => panic!("{other:?}"),
        }
    }

    const URL_MSG: &str = "links[0].url must be a full http:// or https:// address";

    #[test]
    fn f028_links_normalised() {
        let out = validate_links(vec![
            link(" Site ", " HTTPS://Example.com/a?b#c "),
            link("", "Http://a.b:8080"),
            link("x", "http://a-b.c.d?q=1"),
        ])
        .unwrap();
        assert_eq!(out[0].label, "Site");
        assert_eq!(out[0].url, "https://Example.com/a?b#c");
        assert_eq!(out[1].label, "");
        assert_eq!(out[1].url, "http://a.b:8080");
        assert_eq!(out[2].url, "http://a-b.c.d?q=1");
        assert!(validate_links(vec![]).unwrap().is_empty());
        assert_eq!(
            validate_links(vec![link("", "https://x.com#frag")]).unwrap()[0].url,
            "https://x.com#frag"
        );
    }

    #[test]
    fn f028_links_count() {
        let four = (0..4).map(|_| link("", "https://x.com")).collect();
        assert_eq!(err(four), "links must have at most 3 items");
    }

    #[test]
    fn f028_links_label_rules() {
        assert_eq!(
            err(vec![link("a\u{7}b", "https://x.com")]),
            "links[0].label must not contain control characters"
        );
        assert_eq!(
            err(vec![link("a\u{7F}", "https://x.com")]),
            "links[0].label must not contain control characters"
        );
        // C1 controls and bidi / invisible formatting characters, at both ends of each range.
        for c in [
            '\u{80}', '\u{85}', '\u{9F}', '\u{200B}', '\u{200F}', '\u{202A}', '\u{202E}',
            '\u{2060}', '\u{2064}', '\u{2066}', '\u{2069}', '\u{FEFF}',
        ] {
            assert_eq!(
                err(vec![link(&format!("a{c}b"), "https://x.com")]),
                "links[0].label must not contain control characters",
                "U+{:04X}",
                c as u32
            );
        }
        // Neighbours of those ranges stay allowed.
        for c in [
            '\u{A0}', '\u{200A}', '\u{2010}', '\u{2029}', '\u{202F}', '\u{2065}', '\u{206A}',
            '\u{FEFE}',
        ] {
            assert!(
                validate_links(vec![link(&format!("a{c}b"), "https://x.com")]).is_ok(),
                "U+{:04X}",
                c as u32
            );
        }
        assert_eq!(
            err(vec![link(&"a".repeat(31), "https://x.com")]),
            "links[0].label must be at most 30 characters"
        );
        // 30 characters (multi-byte) is fine; surrounding whitespace is trimmed first.
        assert!(
            validate_links(vec![link(
                &format!(" {} ", "é".repeat(30)),
                "https://x.com"
            )])
            .is_ok()
        );
        // Index is 0-based and the control check comes before the length check.
        assert_eq!(
            err(vec![
                link("ok", "https://x.com"),
                link(&format!("{}\u{1}", "a".repeat(40)), "nope")
            ]),
            "links[1].label must not contain control characters"
        );
    }

    #[test]
    fn f028_links_url_rules() {
        let long = format!("https://x.com/{}", "a".repeat(201 - 14));
        assert_eq!(long.len(), 201);
        assert_eq!(
            err(vec![link("", &long)]),
            "links[0].url must be at most 200 characters"
        );
        let ok200 = format!("https://x.com/{}", "a".repeat(200 - 14));
        assert!(validate_links(vec![link("", &ok200)]).is_ok());
        for bad in [
            "",
            "   ",
            "javascript:alert(1)",
            "ftp://x.com",
            "https://user@x.com",
            "https://x.com@evil.com",
            "https://localhost",
            "https://-x.com",
            "https://x.com-",
            "https://.x.com",
            "https://x.com.",
            "https://x.com/ a",
            "https://exämple.com",
            "https://x.com:123456",
            "https://x.com:",
            "https://x.com:8a",
            "https://",
            "https://x_y.com",
            "http//x.com",
            "https:/x.com",
            "https://x.com\u{7}",
        ] {
            assert_eq!(err(vec![link("", bad)]), URL_MSG, "{bad:?}");
        }
        for good in [
            "https://x.com",
            "http://x.com/",
            "HTTP://X.COM/Path?A=B",
            "https://x.com:1",
            "https://x.com:65535/a",
            "https://1.2.3.4",
            "https://x.com/@mia",
            "https://youtube.com/@mia",
        ] {
            assert!(validate_links(vec![link("", good)]).is_ok(), "{good}");
        }
    }
}
