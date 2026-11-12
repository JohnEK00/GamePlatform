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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_public_origin;

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
