//! Runtime configuration, read from environment variables.

use std::path::PathBuf;

pub const DEFAULT_CORS_ORIGINS: &str =
    "http://localhost:5173,http://localhost:1420,http://tauri.localhost,tauri://localhost";
const DEV_JWT_SECRET: &str = "dev-insecure-jwt-secret-change-me";

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub data_dir: PathBuf,
    pub jwt_secret: String,
    pub engine_dist: PathBuf,
    pub web_dist: Option<PathBuf>,
    pub cors_origins: Vec<String>,
    /// Canonical public origin for `/play` (`PUBLIC_ORIGIN`); `None` = derive from `Host`.
    pub public_origin: Option<String>,
    /// Lowercased usernames that get the `admin` role (`ADMIN_USERNAMES`).
    pub admin_usernames: Vec<String>,
    /// Rate limiting on/off (`RATE_LIMIT=off` disables).
    pub rate_limit: bool,
    /// Number of trusted reverse-proxy hops in front of the server (`TRUST_PROXY`; `true` = 1,
    /// off = 0). When > 0 the client IP is the n-th `X-Forwarded-For` entry from the right.
    pub trust_proxy: usize,
    /// Maximum age of the trending snapshot (`TRENDING_TTL_SECS`, default 600; 0 = refresh on
    /// every trending/related read).
    pub trending_ttl: std::time::Duration,
}

pub const DEFAULT_TRENDING_TTL_SECS: u64 = 600;

/// `TRENDING_TTL_SECS`: unset → 600, otherwise a non-negative integer number of seconds.
pub fn parse_trending_ttl(value: Option<&str>) -> Result<std::time::Duration, String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(std::time::Duration::from_secs(DEFAULT_TRENDING_TTL_SECS)),
        Some(v) => v
            .parse::<u64>()
            .map(std::time::Duration::from_secs)
            .map_err(|_| format!("TRENDING_TTL_SECS must be a non-negative integer, got {v:?}")),
    }
}

pub fn parse_admin_usernames(list: &str) -> Vec<String> {
    list.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn env_flag(key: &str, default: bool) -> bool {
    match env_nonempty(key).map(|v| v.to_ascii_lowercase()) {
        None => default,
        Some(v) => !matches!(v.as_str(), "off" | "0" | "false" | "no" | "disabled"),
    }
}

/// `TRUST_PROXY`: unset/off/0/false/no/disabled → 0, true/on/yes → 1, or a hop count.
pub fn parse_trust_proxy(value: Option<&str>) -> Result<usize, String> {
    let Some(v) = value.map(|v| v.trim().to_ascii_lowercase()) else {
        return Ok(0);
    };
    match v.as_str() {
        "" | "off" | "0" | "false" | "no" | "disabled" => Ok(0),
        "true" | "on" | "yes" | "enabled" => Ok(1),
        n => n.parse::<usize>().ok().filter(|n| *n <= 32).ok_or_else(|| {
            format!("TRUST_PROXY must be off, true or a number of proxy hops (0-32), got {v:?}")
        }),
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn parse_origins(list: &str) -> Vec<String> {
    list.split(',')
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Validate a `PUBLIC_ORIGIN` value: `http(s)://host[:port]`, no userinfo, path, query or
/// fragment. A single trailing slash is stripped; scheme and host are lowercased.
pub fn parse_public_origin(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let err = |why: &str| {
        Err(format!(
            "invalid PUBLIC_ORIGIN {raw:?}: {why} (expected e.g. https://arcade.example.com or http://host:8080)"
        ))
    };
    let lower = raw.to_ascii_lowercase();
    let (scheme, rest) = match lower.split_once("://") {
        Some((s @ ("http" | "https"), rest)) => (s, rest),
        Some(_) => return err("scheme must be http or https"),
        None => return err("missing http:// or https:// scheme"),
    };
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() {
        return err("missing host");
    }
    if authority.contains(['/', '?', '#']) {
        return err("must not contain a path, query or fragment");
    }
    if authority.contains('@') {
        return err("must not contain user info");
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        // IPv6 literal: [addr] or [addr]:port
        let Some((addr, tail)) = after.split_once(']') else {
            return err("unterminated IPv6 address");
        };
        if addr.is_empty()
            || !addr
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return err("invalid IPv6 address");
        }
        let port = match tail {
            "" => None,
            t => match t.strip_prefix(':') {
                Some(p) => Some(p),
                None => return err("unexpected characters after IPv6 address"),
            },
        };
        (&authority[..addr.len() + 2], port)
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if !host.starts_with('[') {
        let valid_host = !host.is_empty()
            && host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        if !valid_host {
            return err("invalid host");
        }
    }
    if let Some(p) = port {
        let ok = !p.is_empty()
            && p.len() <= 5
            && p.chars().all(|c| c.is_ascii_digit())
            && p.parse::<u16>().is_ok_and(|n| n > 0);
        if !ok {
            return err("invalid port");
        }
    }
    Ok(format!("{scheme}://{authority}"))
}

impl Config {
    /// Read configuration from the environment. Fails if `PUBLIC_ORIGIN` is set but invalid.
    pub fn from_env() -> Result<Self, String> {
        let port = env_nonempty("PORT")
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);
        let database_url = env_nonempty("DATABASE_URL")
            .unwrap_or_else(|| "sqlite://data/webgame.db?mode=rwc".to_string());
        let data_dir = PathBuf::from(env_nonempty("DATA_DIR").unwrap_or_else(|| "data".into()));
        let jwt_secret = match env_nonempty("JWT_SECRET") {
            Some(s) => s,
            None => {
                tracing::warn!("JWT_SECRET is not set; using an insecure development default");
                DEV_JWT_SECRET.to_string()
            }
        };
        let engine_dist = PathBuf::from(
            env_nonempty("ENGINE_DIST").unwrap_or_else(|| "../packages/engine/dist".into()),
        );
        let web_dist = env_nonempty("WEB_DIST").map(PathBuf::from);
        let cors_origins = parse_origins(
            &env_nonempty("CORS_ORIGINS").unwrap_or_else(|| DEFAULT_CORS_ORIGINS.to_string()),
        );
        let public_origin = env_nonempty("PUBLIC_ORIGIN")
            .map(|v| parse_public_origin(&v))
            .transpose()?;
        Ok(Self {
            port,
            database_url,
            data_dir,
            jwt_secret,
            engine_dist,
            web_dist,
            cors_origins,
            public_origin,
            admin_usernames: parse_admin_usernames(
                &env_nonempty("ADMIN_USERNAMES").unwrap_or_default(),
            ),
            rate_limit: env_flag("RATE_LIMIT", true),
            trust_proxy: parse_trust_proxy(env_nonempty("TRUST_PROXY").as_deref())?,
            trending_ttl: parse_trending_ttl(env_nonempty("TRENDING_TTL_SECS").as_deref())?,
        })
    }

    /// Convenience constructor (mainly for tests): DB and files live under `data_dir`.
    pub fn for_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        let db_path = data_dir.join("webgame.db");
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            db_path.to_string_lossy().replace('\\', "/")
        );
        Self {
            port: 0,
            database_url,
            data_dir,
            jwt_secret: "test-secret".into(),
            engine_dist: PathBuf::from("../packages/engine/dist"),
            web_dist: None,
            cors_origins: parse_origins(DEFAULT_CORS_ORIGINS),
            public_origin: None,
            admin_usernames: Vec::new(),
            rate_limit: false,
            trust_proxy: 0,
            trending_ttl: std::time::Duration::from_secs(DEFAULT_TRENDING_TTL_SECS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_public_origin, parse_trending_ttl, parse_trust_proxy};

    #[test]
    fn trending_ttl_values() {
        use std::time::Duration;
        assert_eq!(parse_trending_ttl(None), Ok(Duration::from_secs(600)));
        assert_eq!(parse_trending_ttl(Some("0")), Ok(Duration::ZERO));
        assert_eq!(
            parse_trending_ttl(Some(" 30 ")),
            Ok(Duration::from_secs(30))
        );
        for bad in ["-1", "1.5", "ten"] {
            assert!(parse_trending_ttl(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn trust_proxy_values() {
        for (input, want) in [
            (None, 0),
            (Some("off"), 0),
            (Some("0"), 0),
            (Some("false"), 0),
            (Some("true"), 1),
            (Some(" TRUE "), 1),
            (Some("1"), 1),
            (Some("2"), 2),
        ] {
            assert_eq!(parse_trust_proxy(input), Ok(want), "{input:?}");
        }
        for bad in ["maybe", "-1", "1.5", "100"] {
            assert!(parse_trust_proxy(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn accepts_valid_origins() {
        let ok = [
            ("https://arcade.example.com", "https://arcade.example.com"),
            ("https://arcade.example.com/", "https://arcade.example.com"),
            ("http://localhost:8080", "http://localhost:8080"),
            (
                "  HTTPS://Arcade.Example.COM:443/ ",
                "https://arcade.example.com:443",
            ),
            ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("http://[::1]:8080", "http://[::1]:8080"),
            ("http://[::1]", "http://[::1]"),
        ];
        for (input, want) in ok {
            assert_eq!(parse_public_origin(input).as_deref(), Ok(want), "{input}");
        }
    }

    #[test]
    fn rejects_invalid_origins() {
        let bad = [
            "",
            "arcade.example.com",
            "ftp://arcade.example.com",
            "javascript://x",
            "https://",
            "https:///",
            "https://arcade.example.com/play",
            "https://arcade.example.com//",
            "https://arcade.example.com?x=1",
            "https://arcade.example.com#frag",
            "https://user:pw@arcade.example.com",
            "https://arcade.example.com:",
            "https://arcade.example.com:0",
            "https://arcade.example.com:70000",
            "https://arcade.example.com:80a",
            "https://arc ade.example.com",
            "https://-bad.example.com",
            "https://a..b",
            "https://[::1",
            "https://[::1]x",
            "https://exa\"mple.com",
        ];
        for input in bad {
            let e = parse_public_origin(input).expect_err(input);
            assert!(e.contains("PUBLIC_ORIGIN"), "{e}");
        }
    }
}
