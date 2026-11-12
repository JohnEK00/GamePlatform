//! On-disk layout under `DATA_DIR`:
//!
//! ```text
//! data/games/{id}/v{version}/...   extracted bundle (only the current version is kept)
//! data/thumbnails/{id}.{ext}
//! data/avatars/{userId}.{ext}
//! ```

use std::path::{Path, PathBuf};

pub const IMAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const IMAGE_EXTS: [&str; 3] = ["png", "jpg", "webp"];

#[derive(Debug, Clone)]
pub struct Storage {
    root: PathBuf,
}

impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.games_root())?;
        std::fs::create_dir_all(self.thumbnails_dir())?;
        std::fs::create_dir_all(self.avatars_dir())?;
        Ok(())
    }

    pub fn games_root(&self) -> PathBuf {
        self.root.join("games")
    }

    pub fn game_dir(&self, game_id: &str) -> PathBuf {
        self.games_root().join(game_id)
    }

    pub fn version_dir(&self, game_id: &str, version: i64) -> PathBuf {
        self.game_dir(game_id).join(format!("v{version}"))
    }

    /// A fresh staging dir for extracting an upload before it is moved into place.
    pub fn staging_dir(&self, game_id: &str) -> PathBuf {
        self.game_dir(game_id)
            .join(format!(".staging-{}", uuid::Uuid::new_v4()))
    }

    pub fn thumbnails_dir(&self) -> PathBuf {
        self.root.join("thumbnails")
    }

    pub fn avatars_dir(&self) -> PathBuf {
        self.root.join("avatars")
    }

    pub fn thumbnail_path(&self, game_id: &str, ext: &str) -> PathBuf {
        self.thumbnails_dir().join(format!("{game_id}.{ext}"))
    }

    pub fn avatar_path(&self, user_id: &str, ext: &str) -> PathBuf {
        self.avatars_dir().join(format!("{user_id}.{ext}"))
    }

    /// Write an image for `stem` (`{stem}.{ext}`) and remove variants with other extensions.
    pub async fn replace_image(
        &self,
        dir: &Path,
        stem: &str,
        ext: &str,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        tokio::fs::create_dir_all(dir).await?;
        let tmp = dir.join(format!(".{stem}.{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, dir.join(format!("{stem}.{ext}"))).await?;
        for other in IMAGE_EXTS.iter().filter(|e| **e != ext) {
            let _ = tokio::fs::remove_file(dir.join(format!("{stem}.{other}"))).await;
        }
        Ok(())
    }

    pub async fn remove_images(&self, dir: &Path, stem: &str) {
        for ext in IMAGE_EXTS {
            let _ = tokio::fs::remove_file(dir.join(format!("{stem}.{ext}"))).await;
        }
    }
}

/// Detect png/jpg/webp by magic bytes; returns the canonical extension.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Validate an uploaded image (≤ 2MB, png/jpg/webp). Returns its extension.
pub fn validate_image(bytes: &[u8], field: &str) -> Result<&'static str, crate::error::AppError> {
    use crate::error::AppError;
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err(AppError::PayloadTooLarge(format!(
            "{field} must be at most 2MB"
        )));
    }
    sniff_image(bytes)
        .ok_or_else(|| AppError::validation(format!("{field} must be a PNG, JPEG or WebP image")))
}
