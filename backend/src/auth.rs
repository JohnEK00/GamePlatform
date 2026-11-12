//! Password hashing, JWT issuing/verification and auth extractors.

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::error::AppError;

pub const TOKEN_TTL_SECS: i64 = 7 * 24 * 60 * 60;
pub const PREVIEW_TOKEN_TTL_SECS: i64 = 10 * 60;

/// `scope` claim of session tokens (API authentication).
pub const SCOPE_SESSION: &str = "session";
/// `scope` claim of preview tokens (only valid for `/play/{gid}?token=`).
pub const SCOPE_PREVIEW: &str = "preview";

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub iat: i64,
    pub exp: i64,
    /// `"session"` or `"preview"`. Tokens without a scope are rejected everywhere.
    #[serde(default)]
    pub scope: Option<String>,
    /// Game id, preview tokens only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gid: Option<String>,
}

fn encode_claims(secret: &str, claims: &Claims) -> Result<String, AppError> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("jwt encode: {e}")))
}

fn decode_claims(secret: &str, token: &str) -> Option<Claims> {
    let validation = Validation::new(Algorithm::HS256);
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()
    .map(|d| d.claims)
}

/// Session token (scope `"session"`, 7 days).
pub fn create_token(secret: &str, user_id: &str) -> Result<String, AppError> {
    let now = chrono::Utc::now().timestamp();
    encode_claims(
        secret,
        &Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + TOKEN_TTL_SECS,
            scope: Some(SCOPE_SESSION.into()),
            gid: None,
        },
    )
}

/// Preview token for one game (scope `"preview"`, 10 minutes). Returns (token, exp unix secs).
pub fn create_preview_token(
    secret: &str,
    user_id: &str,
    game_id: &str,
) -> Result<(String, i64), AppError> {
    let now = chrono::Utc::now().timestamp();
    let exp = now + PREVIEW_TOKEN_TTL_SECS;
    let token = encode_claims(
        secret,
        &Claims {
            sub: user_id.to_string(),
            iat: now,
            exp,
            scope: Some(SCOPE_PREVIEW.into()),
            gid: Some(game_id.to_string()),
        },
    )?;
    Ok((token, exp))
}

/// Returns the user id (`sub`) of a valid **session** token. Preview tokens are rejected.
pub fn verify_token(secret: &str, token: &str) -> Option<String> {
    decode_claims(secret, token)
        .filter(|c| c.scope.as_deref() == Some(SCOPE_SESSION))
        .map(|c| c.sub)
}

/// Returns the user id (`sub`) of a valid preview token for `game_id`. Session tokens are rejected.
pub fn verify_preview_token(secret: &str, token: &str, game_id: &str) -> Option<String> {
    decode_claims(secret, token)
        .filter(|c| c.scope.as_deref() == Some(SCOPE_PREVIEW) && c.gid.as_deref() == Some(game_id))
        .map(|c| c.sub)
}

pub async fn hash_password(password: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
            .map_err(|e| AppError::Internal(format!("salt: {e}")))?;
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| AppError::Internal(format!("hash: {e}")))
    })
    .await?
}

pub async fn verify_password(password: String, hash: String) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || {
        let parsed = match PasswordHash::new(&hash) {
            Ok(p) => p,
            Err(_) => return false,
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
    .await
    .map_err(AppError::from)
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        let t = token.trim();
        (!t.is_empty()).then_some(t)
    } else {
        None
    }
}

/// Resolve a token to an existing user id.
pub async fn user_id_from_token(state: &AppState, token: &str) -> Result<Option<String>, AppError> {
    let Some(sub) = verify_token(&state.config.jwt_secret, token) else {
        return Ok(None);
    };
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE id = ?")
        .bind(&sub)
        .fetch_optional(&state.db)
        .await?;
    Ok(exists.map(|(id,)| id))
}

/// Required authentication: 401 when missing/invalid.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or_else(AppError::unauthorized)?;
        match user_id_from_token(state, token).await? {
            Some(id) => Ok(AuthUser { id }),
            None => Err(AppError::Unauthorized("Invalid or expired token".into())),
        }
    }
}

/// Optional authentication: an absent or invalid token yields `None`.
#[derive(Debug, Clone)]
pub struct MaybeAuthUser(pub Option<String>);

impl MaybeAuthUser {
    pub fn id(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match bearer_token(parts) {
            Some(token) => Ok(MaybeAuthUser(user_id_from_token(state, token).await?)),
            None => Ok(MaybeAuthUser(None)),
        }
    }
}
