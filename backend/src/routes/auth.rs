//! /api/auth/*

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;

use crate::AppState;
use crate::auth::{AuthUser, create_token, hash_password, verify_password};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::models::{AuthResponse, USER_COLUMNS, User, now_rfc3339, user_from_row};

#[derive(Deserialize)]
pub struct RegisterBody {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub login: String,
    pub password: String,
}

pub fn validate_username(username: &str) -> AppResult<()> {
    let len = username.chars().count();
    if !(3..=24).contains(&len)
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::validation(
            "Username must be 3-24 characters of letters, digits or underscore",
        ));
    }
    Ok(())
}

fn validate_email(email: &str) -> AppResult<()> {
    let ok = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        });
    if ok {
        Ok(())
    } else {
        Err(AppError::validation("Invalid email address"))
    }
}

fn validate_password(password: &str) -> AppResult<()> {
    let len = password.chars().count();
    if len < 8 {
        return Err(AppError::validation(
            "Password must be at least 8 characters",
        ));
    }
    if password.len() > 1024 {
        return Err(AppError::validation("Password is too long"));
    }
    Ok(())
}

pub async fn load_user(state: &AppState, id: &str) -> AppResult<User> {
    let row = sqlx::query(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("User"))?;
    Ok(user_from_row(&row)?)
}

/// Create a user (shared by the register endpoint and the seeder). Returns the user id.
pub async fn create_user(
    state: &AppState,
    username: &str,
    email: &str,
    password: &str,
) -> AppResult<String> {
    validate_username(username)?;
    validate_email(email)?;
    validate_password(password)?;

    let username_lower = username.to_ascii_lowercase();
    let email_lower = email.to_lowercase();
    let taken: Option<(String, String)> = sqlx::query_as(
        "SELECT username_lower, email_lower FROM users WHERE username_lower = ? OR email_lower = ?",
    )
    .bind(&username_lower)
    .bind(&email_lower)
    .fetch_optional(&state.db)
    .await?;
    if let Some((u, _)) = taken {
        return Err(AppError::Conflict(if u == username_lower {
            "Username is already taken".into()
        } else {
            "Email is already registered".into()
        }));
    }

    let hash = hash_password(password.to_string()).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let res = sqlx::query(
        "INSERT INTO users (id, username, username_lower, email, email_lower, password_hash, \
         display_name, bio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)",
    )
    .bind(&id)
    .bind(username)
    .bind(&username_lower)
    .bind(email)
    .bind(&email_lower)
    .bind(&hash)
    .bind(username)
    .bind(now_rfc3339())
    .execute(&state.db)
    .await;
    match res {
        Ok(_) => Ok(id),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(AppError::Conflict(
            "Username or email is already taken".into(),
        )),
        Err(e) => Err(e.into()),
    }
}

pub async fn register(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<RegisterBody>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    let username = body.username.trim();
    let email = body.email.trim();
    let id = create_user(&state, username, email, &body.password).await?;
    let user = load_user(&state, &id).await?;
    let token = create_token(&state.config.jwt_secret, &id)?;
    Ok((StatusCode::CREATED, Json(AuthResponse { token, user })))
}

pub async fn login(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<LoginBody>,
) -> AppResult<Json<AuthResponse>> {
    let login = body.login.trim().to_lowercase();
    let bad = || AppError::Unauthorized("Invalid username/email or password".into());
    if login.is_empty() || body.password.is_empty() {
        return Err(bad());
    }
    let row = sqlx::query(
        "SELECT id, password_hash FROM users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
    )
    .bind(&login)
    .bind(&login)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(bad)?;
    let id: String = row.try_get("id")?;
    let hash: String = row.try_get("password_hash")?;
    if !verify_password(body.password, hash).await? {
        return Err(bad());
    }
    let user = load_user(&state, &id).await?;
    let token = create_token(&state.config.jwt_secret, &id)?;
    Ok(Json(AuthResponse { token, user }))
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<User>> {
    Ok(Json(load_user(&state, &user.id).await?))
}
