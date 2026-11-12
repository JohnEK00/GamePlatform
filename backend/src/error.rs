//! API error type, rendered as `{ "error": { "code", "message" } }`.

use axum::extract::multipart::{MultipartError, MultipartRejection};
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PayloadTooLarge(String),
    #[error("{0}")]
    ServiceUnavailable(String),
    #[error("internal error: {0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::BadRequest(_) => "bad_request",
            AppError::Validation(_) => "validation",
            AppError::Unauthorized(_) => "unauthorized",
            AppError::Forbidden(_) => "forbidden",
            AppError::NotFound(_) => "not_found",
            AppError::Conflict(_) => "conflict",
            AppError::PayloadTooLarge(_) => "payload_too_large",
            AppError::ServiceUnavailable(_) => "unavailable",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn not_found(what: &str) -> Self {
        AppError::NotFound(format!("{what} not found"))
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }

    pub fn unauthorized() -> Self {
        AppError::Unauthorized("Authentication required".into())
    }

    pub fn forbidden() -> Self {
        AppError::Forbidden("You do not have permission to do that".into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let message = match &self {
            AppError::Internal(detail) => {
                tracing::error!(error = %detail, "internal error");
                "Internal server error".to_string()
            }
            other => other.to_string(),
        };
        let body = json!({ "error": { "code": self.code(), "message": message } });
        (self.status(), axum::Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(format!("database: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(format!("io: {e}"))
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(format!("{e:#}"))
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::Internal(format!("task: {e}"))
    }
}

impl From<JsonRejection> for AppError {
    fn from(e: JsonRejection) -> Self {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            return AppError::PayloadTooLarge("Request body too large".into());
        }
        match e {
            JsonRejection::JsonDataError(e) => AppError::Validation(e.body_text()),
            other => AppError::BadRequest(other.body_text()),
        }
    }
}

impl From<QueryRejection> for AppError {
    fn from(e: QueryRejection) -> Self {
        AppError::BadRequest(e.body_text())
    }
}

impl From<PathRejection> for AppError {
    fn from(e: PathRejection) -> Self {
        AppError::BadRequest(e.body_text())
    }
}

impl From<MultipartRejection> for AppError {
    fn from(e: MultipartRejection) -> Self {
        AppError::BadRequest(e.body_text())
    }
}

impl From<MultipartError> for AppError {
    fn from(e: MultipartError) -> Self {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::PayloadTooLarge("Upload too large".into())
        } else {
            AppError::BadRequest(format!("Invalid multipart body: {}", e.body_text()))
        }
    }
}
