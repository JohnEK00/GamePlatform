//! F005 screenshots: decode + re-encode of uploads (no original bytes or metadata are kept)
//! and the on-disk file helpers for `data/screenshots/{id}.{png|jpg}` + `{id}_t.jpg`.

use std::io::Cursor;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits, RgbImage};

use crate::error::AppError;
use crate::storage::Storage;

pub const MIN_SIDE: u32 = 64;
pub const MAX_SIDE: u32 = 4096;
pub const THUMB_MAX: u32 = 480;
pub const MAX_ALLOC: u64 = 128 * 1024 * 1024;
pub const FULL_JPEG_QUALITY: u8 = 90;
pub const THUMB_JPEG_QUALITY: u8 = 80;

/// A re-encoded screenshot, ready to be written.
#[derive(Debug)]
pub struct Processed {
    /// `"png"` (PNG input) or `"jpg"` (JPEG/WebP input).
    pub ext: &'static str,
    pub full: Vec<u8>,
    pub thumb: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn dims_error() -> AppError {
    AppError::validation(format!(
        "image must be between {MIN_SIDE} and {MAX_SIDE} pixels per side"
    ))
}

fn decode_error() -> AppError {
    AppError::validation("image could not be decoded")
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, AppError> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| decode_error())
}

/// Validate dimensions, decode (with limits), flatten alpha on black and re-encode.
/// CPU-bound: run inside `spawn_blocking`.
pub fn process_screenshot(bytes: &[u8]) -> Result<Processed, AppError> {
    // 1. Header dimensions, before any pixel decoding.
    let header = reader(bytes)?;
    let format = header.format();
    if !matches!(
        format,
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(decode_error());
    }
    let (w, h) = header.into_dimensions().map_err(|_| decode_error())?;
    let ok = |s: u32| (MIN_SIDE..=MAX_SIDE).contains(&s);
    if !ok(w) || !ok(h) {
        return Err(dims_error());
    }

    // 2. Decode with limits. Animated inputs yield their first (default) frame.
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    let mut dec = reader(bytes)?;
    dec.limits(limits);
    let img = dec.decode().map_err(|_| decode_error())?;
    let (w, h) = (img.width(), img.height());
    if !ok(w) || !ok(h) {
        return Err(dims_error());
    }

    // 3. RGB8 with alpha composited on black.
    let rgba = img.to_rgba8();
    drop(img);
    let rgb = RgbImage::from_fn(w, h, |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let a = u16::from(p[3]);
        let mul = |c: u8| ((u16::from(c) * a + 127) / 255) as u8;
        image::Rgb([mul(p[0]), mul(p[1]), mul(p[2])])
    });
    drop(rgba);

    // 4. Encode. The encoders write pixels only: no EXIF, XMP, text chunks or ICC.
    let (ext, full) = if format == Some(ImageFormat::Png) {
        let mut out = Vec::new();
        PngEncoder::new_with_quality(&mut out, CompressionType::Fast, PngFilter::Adaptive)
            .write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
            .map_err(|e| AppError::Internal(format!("png encode: {e}")))?;
        ("png", out)
    } else {
        ("jpg", encode_jpeg(&rgb, FULL_JPEG_QUALITY)?)
    };

    let (tw, th) = thumb_size(w, h);
    let thumb = if (tw, th) == (w, h) {
        encode_jpeg(&rgb, THUMB_JPEG_QUALITY)?
    } else {
        let small = image::imageops::resize(&rgb, tw, th, FilterType::Triangle);
        encode_jpeg(&small, THUMB_JPEG_QUALITY)?
    };

    Ok(Processed {
        ext,
        full,
        thumb,
        width: w,
        height: h,
    })
}

fn encode_jpeg(img: &RgbImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| AppError::Internal(format!("jpeg encode: {e}")))?;
    Ok(out)
}

/// Fit inside `THUMB_MAX`×`THUMB_MAX`, keeping the aspect ratio; never upscaled.
pub fn thumb_size(w: u32, h: u32) -> (u32, u32) {
    if w <= THUMB_MAX && h <= THUMB_MAX {
        return (w, h);
    }
    let scale = f64::from(THUMB_MAX) / f64::from(w.max(h));
    let fit = |s: u32| ((f64::from(s) * scale).round() as u32).clamp(1, THUMB_MAX);
    (fit(w), fit(h))
}

pub fn image_url(id: &str, ext: &str) -> String {
    format!("/media/screenshots/{id}.{ext}")
}

pub fn thumb_url(id: &str) -> String {
    format!("/media/screenshots/{id}_t.jpg")
}

async fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&tmp, bytes).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(&tmp, dir.join(name)).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

/// Write `{id}.{ext}` and `{id}_t.jpg` (temp file + rename). On failure nothing is left.
pub async fn write_screenshot_files(
    storage: &Storage,
    id: &str,
    p: &Processed,
) -> std::io::Result<()> {
    let dir = storage.screenshots_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let res = async {
        write_atomic(&dir, &format!("{id}_t.jpg"), &p.thumb).await?;
        write_atomic(&dir, &format!("{id}.{}", p.ext), &p.full).await
    }
    .await;
    if res.is_err() {
        remove_screenshot_files(storage, id).await;
    }
    res
}

/// Remove `{id}.png`, `{id}.jpg` and `{id}_t.jpg` (best effort).
pub async fn remove_screenshot_files(storage: &Storage, id: &str) {
    let dir = storage.screenshots_dir();
    for name in [
        format!("{id}.png"),
        format!("{id}.jpg"),
        format!("{id}_t.jpg"),
    ] {
        let _ = tokio::fs::remove_file(dir.join(name)).await;
    }
}

/// The screenshot id a stored file belongs to (`{id}.png`, `{id}.jpg`, `{id}_t.jpg`).
pub fn id_of_file(name: &str) -> Option<&str> {
    let stem = name
        .strip_suffix("_t.jpg")
        .or_else(|| name.strip_suffix(".png"))
        .or_else(|| name.strip_suffix(".jpg"))?;
    (!stem.is_empty()).then_some(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_fit() {
        assert_eq!(thumb_size(64, 64), (64, 64));
        assert_eq!(thumb_size(480, 480), (480, 480));
        assert_eq!(thumb_size(1280, 720), (480, 270));
        assert_eq!(thumb_size(720, 1280), (270, 480));
        assert_eq!(thumb_size(4096, 64), (480, 8));
    }

    #[test]
    fn file_ids() {
        assert_eq!(id_of_file("abc.png"), Some("abc"));
        assert_eq!(id_of_file("abc.jpg"), Some("abc"));
        assert_eq!(id_of_file("abc_t.jpg"), Some("abc"));
        assert_eq!(id_of_file("abc.webp"), None);
        assert_eq!(id_of_file(".png"), None);
    }
}
