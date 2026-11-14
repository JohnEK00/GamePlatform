//! In-memory token-bucket rate limiting (docs/API.md "Rate limits").
//!
//! Buckets are keyed by `(limit, key)` where `key` is the user id for authenticated requests
//! and the client IP otherwise. The client IP comes from the socket address
//! (`ConnectInfo<SocketAddr>`), or from `X-Forwarded-For` / `X-Real-IP` only when
//! `TRUST_PROXY` (a trusted-hop count) is set; see [`client_ip`].

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;

use crate::AppState;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Limit {
    /// login + register: 10/min per IP
    Auth,
    /// game create + bundle replace: 20/hour
    Upload,
    /// comments: 30 per 10 min
    Comment,
    /// reports: 10/hour
    Report,
    /// score submit: 60/min
    Score,
    /// save PUT: 60/min
    Save,
    /// leaderboard reads (`GET …/leaderboard`): 120/min, per user or per IP when anonymous
    Leaderboard,
    /// play recording (`POST …/play`): 30/min, per user or per IP when anonymous
    Play,
    /// follow + unfollow (`PUT`/`DELETE …/follow`, shared): 60 per 10 min, per user
    Follow,
    /// feed reads (`GET /api/feed` + `/api/feed/suggestions`, shared): 60/min, per user
    Feed,
}

impl Limit {
    /// (capacity, refill period)
    pub fn quota(self) -> (u32, Duration) {
        match self {
            Limit::Auth => (10, Duration::from_secs(60)),
            Limit::Upload => (20, Duration::from_secs(3600)),
            Limit::Comment => (30, Duration::from_secs(600)),
            Limit::Report => (10, Duration::from_secs(3600)),
            Limit::Score => (60, Duration::from_secs(60)),
            Limit::Save => (60, Duration::from_secs(60)),
            Limit::Leaderboard => (120, Duration::from_secs(60)),
            Limit::Play => (30, Duration::from_secs(60)),
            Limit::Follow => (60, Duration::from_secs(600)),
            Limit::Feed => (60, Duration::from_secs(60)),
        }
    }
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

const PRUNE_THRESHOLD: usize = 10_000;

#[derive(Clone)]
pub struct RateLimiter {
    enabled: bool,
    buckets: Arc<Mutex<HashMap<(Limit, String), Bucket>>>,
}

impl RateLimiter {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            buckets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Take one token for `key`, or fail with 429 `rate_limited` + `Retry-After`.
    pub fn check(&self, limit: Limit, key: &str) -> Result<(), AppError> {
        if !self.enabled {
            return Ok(());
        }
        self.check_at(limit, key, Instant::now())
    }

    fn check_at(&self, limit: Limit, key: &str, now: Instant) -> Result<(), AppError> {
        let (cap, period) = limit.quota();
        let cap = cap as f64;
        let rate = cap / period.as_secs_f64(); // tokens per second
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= PRUNE_THRESHOLD {
            // Drop buckets that have refilled completely; they carry no state.
            map.retain(|(l, _), b| {
                let (c, p) = l.quota();
                let r = c as f64 / p.as_secs_f64();
                b.tokens + now.saturating_duration_since(b.last).as_secs_f64() * r < c as f64
            });
        }
        let bucket = map.entry((limit, key.to_string())).or_insert(Bucket {
            tokens: cap,
            last: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate).min(cap);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / rate).ceil().max(1.0) as u64;
            Err(AppError::RateLimited { retry_after: wait })
        }
    }
}

/// Window within which repeated plays of one game by one viewer count once.
pub const PLAY_DEDUPE_WINDOW: Duration = Duration::from_secs(600);

/// In-memory "counted recently" set keyed by `(game id, viewer key)`.
#[derive(Clone, Default)]
pub struct PlayDedupe {
    seen: Arc<Mutex<HashMap<(String, String), Instant>>>,
}

impl PlayDedupe {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` if this play should be counted (none counted for the pair within the window);
    /// records it as counted.
    pub fn should_count(&self, game_id: &str, viewer: &str) -> bool {
        self.should_count_at(game_id, viewer, Instant::now())
    }

    fn should_count_at(&self, game_id: &str, viewer: &str, now: Instant) -> bool {
        let mut map = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= PRUNE_THRESHOLD {
            map.retain(|_, t| now.saturating_duration_since(*t) < PLAY_DEDUPE_WINDOW);
        }
        let key = (game_id.to_string(), viewer.to_string());
        match map.get(&key) {
            Some(t) if now.saturating_duration_since(*t) < PLAY_DEDUPE_WINDOW => false,
            _ => {
                map.insert(key, now);
                true
            }
        }
    }

    /// Forget a counted play (used when the DB write fails).
    pub fn forget(&self, game_id: &str, viewer: &str) {
        let mut map = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(&(game_id.to_string(), viewer.to_string()));
    }
}

/// Best-effort client IP (never fails). `"unknown"` when no address is available.
#[derive(Debug, Clone)]
pub struct ClientIp(pub String);

/// Client IP for rate limiting.
///
/// `trust_proxy` is the number of trusted reverse-proxy hops. With `n > 0`, the address is the
/// n-th `X-Forwarded-For` entry counted from the right (each trusted proxy appends the address
/// it received the request from, so entries left of that are client-controlled). If the header
/// (all `X-Forwarded-For` lines combined) has fewer than `n` entries, the connection address is
/// used. `X-Real-IP` is consulted only when no `X-Forwarded-For` header is present.
pub fn client_ip(parts: &Parts, trust_proxy: usize) -> String {
    let socket = || {
        parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    };
    if trust_proxy == 0 {
        return socket();
    }
    let xff: Vec<&str> = parts
        .headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .collect();
    let has_xff = parts.headers.contains_key("x-forwarded-for");
    let picked = if has_xff {
        xff.len()
            .checked_sub(trust_proxy)
            .and_then(|i| xff.get(i).copied())
    } else {
        parts
            .headers
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
    };
    match picked.filter(|v| !v.is_empty()) {
        Some(ip) => ip.chars().take(64).collect(),
        None => socket(),
    }
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(client_ip(parts, state.config.trust_proxy)))
    }
}

/// Key for a limit: `user:{id}` when authenticated, else `ip:{addr}`.
pub fn key_for(user_id: Option<&str>, ip: &ClientIp) -> String {
    match user_id {
        Some(id) => format!("user:{id}"),
        None => format!("ip:{}", ip.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_refills() {
        let rl = RateLimiter::new(true);
        let t0 = Instant::now();
        for _ in 0..10 {
            rl.check_at(Limit::Auth, "a", t0).unwrap();
        }
        let err = rl.check_at(Limit::Auth, "a", t0).unwrap_err();
        match err {
            AppError::RateLimited { retry_after } => assert_eq!(retry_after, 6),
            other => panic!("{other:?}"),
        }
        // Another key is independent.
        rl.check_at(Limit::Auth, "b", t0).unwrap();
        // 6 seconds refill one token (10/min).
        rl.check_at(Limit::Auth, "a", t0 + Duration::from_secs(6))
            .unwrap();
        assert!(
            rl.check_at(Limit::Auth, "a", t0 + Duration::from_secs(6))
                .is_err()
        );
    }

    fn parts(headers: &[(&str, &str)]) -> Parts {
        let mut b = axum::http::Request::builder();
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let (mut p, _) = b.body(()).unwrap().into_parts();
        p.extensions
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 1], 1234))));
        p
    }

    #[test]
    fn client_ip_trusted_hops() {
        let xff = [("x-forwarded-for", "6.6.6.6, 1.1.1.1, 10.0.0.5")];
        assert_eq!(client_ip(&parts(&xff), 0), "192.0.2.1");
        assert_eq!(client_ip(&parts(&xff), 1), "10.0.0.5");
        assert_eq!(client_ip(&parts(&xff), 2), "1.1.1.1");
        assert_eq!(client_ip(&parts(&xff), 3), "6.6.6.6");
        // Fewer entries than trusted hops: fall back to the connection address.
        assert_eq!(client_ip(&parts(&xff), 4), "192.0.2.1");
        // Multiple header lines are combined in order.
        let multi = [
            ("x-forwarded-for", "6.6.6.6"),
            ("x-forwarded-for", "1.1.1.1"),
        ];
        assert_eq!(client_ip(&parts(&multi), 1), "1.1.1.1");
        // X-Real-IP only without X-Forwarded-For.
        let both = [("x-forwarded-for", "1.1.1.1"), ("x-real-ip", "9.9.9.9")];
        assert_eq!(client_ip(&parts(&both), 1), "1.1.1.1");
        assert_eq!(client_ip(&parts(&both), 2), "192.0.2.1");
        assert_eq!(client_ip(&parts(&[("x-real-ip", "9.9.9.9")]), 1), "9.9.9.9");
        assert_eq!(client_ip(&parts(&[]), 1), "192.0.2.1");
        // Empty entry at the trusted position is ignored.
        assert_eq!(
            client_ip(&parts(&[("x-forwarded-for", "1.1.1.1, ")]), 1),
            "192.0.2.1"
        );
    }

    #[test]
    fn play_dedupe_window() {
        let d = PlayDedupe::new();
        let t0 = Instant::now();
        assert!(d.should_count_at("g", "ip:1", t0));
        assert!(!d.should_count_at("g", "ip:1", t0 + Duration::from_secs(599)));
        assert!(d.should_count_at("g", "ip:2", t0));
        assert!(d.should_count_at("h", "ip:1", t0));
        assert!(d.should_count_at("g", "ip:1", t0 + Duration::from_secs(600)));
    }

    #[test]
    fn disabled_never_limits() {
        let rl = RateLimiter::new(false);
        for _ in 0..100 {
            rl.check(Limit::Auth, "a").unwrap();
        }
    }
}
