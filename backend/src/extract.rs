//! Extractor wrappers that convert axum rejections into [`AppError`] responses.

use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

use crate::error::AppError;

/// JSON body; malformed → 400 `bad_request`, wrong shape → 422 `validation`.
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let axum::Json(v) = axum::Json::<T>::from_request(req, state).await?;
        Ok(ApiJson(v))
    }
}

/// Query string → 400 `bad_request` when unparsable.
pub struct ApiQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let axum::extract::Query(v) =
            axum::extract::Query::<T>::from_request_parts(parts, state).await?;
        Ok(ApiQuery(v))
    }
}

/// Path params → 400 `bad_request` when unparsable.
pub struct ApiPath<T>(pub T);

impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let axum::extract::Path(v) =
            axum::extract::Path::<T>::from_request_parts(parts, state).await?;
        Ok(ApiPath(v))
    }
}

/// Multipart body; rejection → 400.
pub struct ApiMultipart(pub axum::extract::Multipart);

impl<S> FromRequest<S> for ApiMultipart
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let m = axum::extract::Multipart::from_request(req, state).await?;
        Ok(ApiMultipart(m))
    }
}
