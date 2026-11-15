//! F005 screenshots: decode + re-encode of uploads (no original bytes or metadata are kept)
//! and the on-disk file helpers for `data/screenshots/{id}.{png|jpg}` + `{id}_t.jpg`.
//!
//! Memory budget (L3): one decode holds at most [`DECODE_BUDGET`] (80 MiB) of pixel and decoder
//! buffers. Before any pixel is decoded, [`decode_cost`] estimates the peak from the header
//! (decoded buffer + the larger of the decoder's own full-image buffers and the RGB8 conversion)
//! and rejects the image when it is over the budget. The conversion to RGB8 reuses the decoded
//! buffer where it can (RGB8 as is, RGBA8 composited in place). With `IMAGE_SLOTS = 2`, image
//! processing needs at most ~2 × 80 MiB plus the encoded outputs (a few MiB each).

use std::io::Cursor;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{
    ColorType, DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat,
    ImageReader, Limits, Rgb, RgbImage, RgbaImage,
};

use crate::error::AppError;
use crate::storage::Storage;

pub const MIN_SIDE: u32 = 64;
pub const MAX_SIDE: u32 = 4096;
pub const THUMB_MAX: u32 = 480;
/// Peak bytes of pixel + decoder buffers for one decode (L3). Fits an 8-bit RGBA 4096²
/// image (64 MiB) and an 8-bit gray + alpha 4096² image converted to RGB (32 + 48 MiB).
pub const DECODE_BUDGET: u64 = 80 * 1024 * 1024;
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

fn budget_error() -> AppError {
    AppError::validation("image is too large to process; use fewer pixels or 8-bit color")
}

/// Extra full-image buffers the JPEG decoder allocates: a progressive JPEG keeps every DCT
/// coefficient (`i16` per padded sample per component) until the last scan; a baseline JPEG
/// decodes one MCU row at a time (0). `None` when no frame header is found.
fn jpeg_decoder_extra(bytes: &[u8]) -> Option<u64> {
    let mut i = 2usize; // after SOI
    loop {
        while bytes.get(i) == Some(&0xFF) && bytes.get(i + 1) == Some(&0xFF) {
            i += 1; // fill bytes
        }
        if *bytes.get(i)? != 0xFF {
            return None;
        }
        let marker = *bytes.get(i + 1)?;
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            return None; // EOI / SOS before any frame header
        }
        let len = usize::from(u16::from_be_bytes([*bytes.get(i + 2)?, *bytes.get(i + 3)?]));
        let is_sof = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            let seg = bytes.get(i + 4..i + 2 + len)?;
            let height = u64::from(u16::from_be_bytes([*seg.get(1)?, *seg.get(2)?]));
            let width = u64::from(u16::from_be_bytes([*seg.get(3)?, *seg.get(4)?]));
            let n = usize::from(*seg.get(5)?);
            let comps = seg.get(6..6 + 3 * n)?;
            if !matches!(marker, 0xC2 | 0xC6 | 0xCA | 0xCE) {
                return Some(0);
            }
            let factors: Vec<(u64, u64)> = comps
                .chunks_exact(3)
                .map(|c| (u64::from(c[1] >> 4).max(1), u64::from(c[1] & 0x0F).max(1)))
                .collect();
            let hmax = factors.iter().map(|f| f.0).max()?;
            let vmax = factors.iter().map(|f| f.1).max()?;
            let mcus_x = width.div_ceil(8 * hmax);
            let mcus_y = height.div_ceil(8 * vmax);
            let samples: u64 = factors
                .iter()
                .map(|(h, v)| mcus_x * 8 * h * mcus_y * 8 * v)
                .sum();
            return Some(samples * 2);
        }
        i += 2 + len;
    }
}

/// Extra full-image buffers of the WebP decoder: lossless images without alpha decode to an
/// RGBA scratch buffer (4 B/px); lossy images keep YUV planes + alpha (≤ 2.5 B/px); animated
/// images also compose a frame buffer (≤ 7 B/px in total).
fn webp_decoder_extra(bytes: &[u8], pixels: u64) -> u64 {
    let animated = bytes.get(12..16) == Some(b"VP8X".as_slice())
        && bytes.get(20).is_some_and(|f| f & 0x02 != 0);
    pixels * if animated { 7 } else { 4 }
}

/// Estimated peak bytes of decoding and converting this image to RGB8: the decoded buffer,
/// plus the larger of the decoder's own full-image buffers and the conversion's new buffer.
pub fn decode_cost(
    format: ImageFormat,
    bytes: &[u8],
    width: u32,
    height: u32,
    color: ColorType,
    total_bytes: u64,
) -> u64 {
    let px = u64::from(width) * u64::from(height);
    let decoder_extra = match format {
        ImageFormat::Jpeg => jpeg_decoder_extra(bytes).unwrap_or(px * 4 * 2),
        ImageFormat::WebP => webp_decoder_extra(bytes, px),
        _ => 0,
    };
    let convert_extra = match color {
        // Used as is / composited in place.
        ColorType::Rgb8 | ColorType::Rgba8 => 0,
        // A new RGB8 buffer next to the gray one.
        ColorType::L8 | ColorType::La8 => px * 3,
        // 16-bit / float: a new RGBA8 buffer, then composited in place.
        _ => px * 4,
    };
    total_bytes.saturating_add(decoder_extra.max(convert_extra))
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, AppError> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| decode_error())
}

/// Alpha composited on black: `c * a / 255`, rounded.
fn mul_alpha(c: u8, a: u8) -> u8 {
    ((u16::from(c) * u16::from(a) + 127) / 255) as u8
}

/// RGBA8 → RGB8 with alpha composited on black, in the same allocation.
fn rgba_into_rgb(img: RgbaImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut buf = img.into_raw();
    let n = buf.len() / 4;
    for i in 0..n {
        // Pixel i is read from 4i.. before 3i..3i+3 is written; 3i + 2 < 4(i + 1), so no
        // unread byte is overwritten.
        let s = i * 4;
        let a = buf[s + 3];
        let (r, g, b) = (
            mul_alpha(buf[s], a),
            mul_alpha(buf[s + 1], a),
            mul_alpha(buf[s + 2], a),
        );
        let d = i * 3;
        buf[d] = r;
        buf[d + 1] = g;
        buf[d + 2] = b;
    }
    buf.truncate(n * 3);
    RgbImage::from_raw(w, h, buf).expect("RGB buffer has w*h*3 bytes")
}

/// Any decoded image → RGB8 with alpha composited on black, with at most one extra buffer
/// (accounted for in [`decode_cost`]).
fn flatten(img: DynamicImage) -> RgbImage {
    match img {
        DynamicImage::ImageRgb8(rgb) => rgb,
        DynamicImage::ImageRgba8(rgba) => rgba_into_rgb(rgba),
        DynamicImage::ImageLuma8(l) => RgbImage::from_fn(l.width(), l.height(), |x, y| {
            let v = l.get_pixel(x, y).0[0];
            Rgb([v, v, v])
        }),
        DynamicImage::ImageLumaA8(la) => RgbImage::from_fn(la.width(), la.height(), |x, y| {
            let [v, a] = la.get_pixel(x, y).0;
            let v = mul_alpha(v, a);
            Rgb([v, v, v])
        }),
        other => rgba_into_rgb(other.into_rgba8()),
    }
}

/// Validate dimensions and the memory budget from the header, decode (with limits), flatten
/// alpha on black and re-encode. CPU-bound: run inside `spawn_blocking`.
pub fn process_screenshot(bytes: &[u8]) -> Result<Processed, AppError> {
    // 1. Header only: format, dimensions, color type, before any pixel decoding.
    let mut r = reader(bytes)?;
    let format = match r.format() {
        Some(f @ (ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) => f,
        _ => return Err(decode_error()),
    };
    r.no_limits(); // dimensions are checked below with the specific message
    let mut dec = r.into_decoder().map_err(|_| decode_error())?;
    let (w, h) = dec.dimensions();
    let ok = |s: u32| (MIN_SIDE..=MAX_SIDE).contains(&s);
    if !ok(w) || !ok(h) {
        return Err(dims_error());
    }
    let total = dec.total_bytes();
    if decode_cost(format, bytes, w, h, dec.color_type(), total) > DECODE_BUDGET {
        return Err(budget_error());
    }

    // 2. Decode with limits: the output buffer is reserved, the decoder's own allocations
    // (where it reports them) get the rest. Animated inputs yield their first frame.
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(DECODE_BUDGET);
    limits.reserve(total).map_err(|_| budget_error())?;
    dec.set_limits(limits).map_err(|_| budget_error())?;
    let img = DynamicImage::from_decoder(dec).map_err(|_| decode_error())?;
    let (w, h) = (img.width(), img.height());
    if !ok(w) || !ok(h) {
        return Err(dims_error());
    }

    // 3. RGB8 with alpha composited on black (reusing the decoded buffer where possible).
    let rgb = flatten(img);

    // 4. Encode. The encoders write pixels only: no EXIF, XMP, text chunks or ICC. The
    // thumbnail uses the integer area sampler, which allocates only the output.
    let (tw, th) = thumb_size(w, h);
    let thumb = if (tw, th) == (w, h) {
        encode_jpeg(&rgb, THUMB_JPEG_QUALITY)?
    } else {
        let small = image::imageops::thumbnail(&rgb, tw, th);
        encode_jpeg(&small, THUMB_JPEG_QUALITY)?
    };
    let (ext, full) = if format == ImageFormat::Png {
        let mut out = Vec::new();
        PngEncoder::new_with_quality(&mut out, CompressionType::Fast, PngFilter::Adaptive)
            .write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
            .map_err(|e| AppError::Internal(format!("png encode: {e}")))?;
        ("png", out)
    } else {
        ("jpg", encode_jpeg(&rgb, FULL_JPEG_QUALITY)?)
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

    const MIB: u64 = 1024 * 1024;

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut typed = kind.to_vec();
        typed.extend_from_slice(data);
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&typed);
        out.extend_from_slice(&crc32(&typed).to_be_bytes());
        out
    }

    /// A PNG whose IHDR says `w`×`h` at `depth` bits, colour type `ct`, followed by a tiny
    /// (invalid) IDAT: only header-level checks can pass on it.
    pub(crate) fn png_header_only(w: u32, h: u32, depth: u8, ct: u8) -> Vec<u8> {
        let mut ihdr = w.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[depth, ct, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend(chunk(b"IHDR", &ihdr));
        out.extend(chunk(b"IDAT", &[0x78, 0x9C, 0x03, 0x00]));
        out.extend(chunk(b"IEND", &[]));
        out
    }

    fn message(e: AppError) -> String {
        match e {
            AppError::Validation(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn l3_sixteen_bit_4096_png_is_rejected_before_decoding() {
        // 4096² RGBA16 = 128 MiB decoded (+ 64 MiB RGBA8): over the 80 MiB budget.
        let png = png_header_only(4096, 4096, 16, 6);
        assert!(png.len() < 100);
        let err = process_screenshot(&png).unwrap_err();
        assert_eq!(message(err), message(budget_error()));
        // RGB16 4096² (96 MiB) too.
        let err = process_screenshot(&png_header_only(4096, 4096, 16, 2)).unwrap_err();
        assert_eq!(message(err), message(budget_error()));
        // 8-bit RGBA 4096² is within the budget: it gets as far as the (broken) pixel data.
        let err = process_screenshot(&png_header_only(4096, 4096, 8, 6)).unwrap_err();
        assert_eq!(message(err), message(decode_error()));
    }

    #[test]
    fn l3_decode_cost_budget() {
        let cost = |ct, bpp: u64, w: u32, h: u32| {
            decode_cost(
                ImageFormat::Png,
                &[],
                w,
                h,
                ct,
                u64::from(w) * u64::from(h) * bpp,
            )
        };
        assert_eq!(cost(ColorType::Rgba8, 4, 4096, 4096), 64 * MIB);
        assert_eq!(cost(ColorType::Rgb8, 3, 4096, 4096), 48 * MIB);
        assert_eq!(cost(ColorType::L8, 1, 4096, 4096), 64 * MIB);
        assert_eq!(cost(ColorType::La8, 2, 4096, 4096), 80 * MIB);
        assert!(cost(ColorType::Rgba16, 8, 4096, 4096) > DECODE_BUDGET);
        assert!(cost(ColorType::Rgb16, 6, 4096, 4096) > DECODE_BUDGET);
        // Small 16-bit images still fit (decoded + RGBA8 copy).
        assert_eq!(cost(ColorType::Rgba16, 8, 2048, 2048), 48 * MIB);
        // WebP: decoder scratch buffers count.
        let webp = decode_cost(
            ImageFormat::WebP,
            b"RIFF\0\0\0\0WEBPVP8L",
            4096,
            4096,
            ColorType::Rgb8,
            48 * MIB,
        );
        assert_eq!(webp, 112 * MIB);
    }

    /// A minimal JPEG header: SOI, SOFn with the given sampling factors, SOS.
    fn jpeg_header(marker: u8, w: u16, h: u16, factors: &[u8]) -> Vec<u8> {
        let mut sof = vec![8];
        sof.extend_from_slice(&h.to_be_bytes());
        sof.extend_from_slice(&w.to_be_bytes());
        sof.push(factors.len() as u8);
        for (i, f) in factors.iter().enumerate() {
            sof.extend_from_slice(&[i as u8 + 1, *f, 0]);
        }
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0]; // SOI + short APP0
        out.extend_from_slice(&[0xFF, marker]);
        out.extend_from_slice(&((sof.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&sof);
        out.extend_from_slice(&[0xFF, 0xDA]);
        out
    }

    #[test]
    fn l3_progressive_jpeg_coefficients_count() {
        // Baseline: decoded one MCU row at a time.
        assert_eq!(
            jpeg_decoder_extra(&jpeg_header(0xC0, 4096, 4096, &[0x22, 0x11, 0x11])),
            Some(0)
        );
        // Progressive 4:2:0: Y full size + 2 quarter-size chroma planes, i16 each.
        assert_eq!(
            jpeg_decoder_extra(&jpeg_header(0xC2, 4096, 4096, &[0x22, 0x11, 0x11])),
            Some((4096 * 4096 + 2 * 2048 * 2048) * 2)
        );
        // Progressive 4:4:4, padded to whole MCUs.
        assert_eq!(
            jpeg_decoder_extra(&jpeg_header(0xC2, 100, 10, &[0x11, 0x11, 0x11])),
            Some(3 * 104 * 16 * 2)
        );
        assert_eq!(jpeg_decoder_extra(&[0xFF, 0xD8, 0xFF, 0xDA]), None);
        assert_eq!(jpeg_decoder_extra(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn l3_flatten_in_place_and_sixteen_bit() {
        let rgba = RgbaImage::from_fn(70, 65, |x, y| {
            image::Rgba([x as u8, y as u8, 200, if x % 2 == 0 { 255 } else { 0 }])
        });
        let rgb = rgba_into_rgb(rgba.clone());
        assert_eq!(rgb.dimensions(), (70, 65));
        for (x, y, p) in rgb.enumerate_pixels() {
            let want = if x % 2 == 0 {
                [x as u8, y as u8, 200]
            } else {
                [0, 0, 0]
            };
            assert_eq!(p.0, want, "{x},{y}");
        }
        // A real 16-bit PNG within the budget is accepted and converted to 8 bits.
        let src = image::ImageBuffer::<image::Rgba<u16>, Vec<u16>>::from_pixel(
            80,
            64,
            image::Rgba([65535, 0, 32896, 65535]),
        );
        let mut png = Vec::new();
        DynamicImage::ImageRgba16(src)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let p = process_screenshot(&png).unwrap();
        assert_eq!((p.ext, p.width, p.height), ("png", 80, 64));
        let out = image::load_from_memory(&p.full).unwrap().into_rgb8();
        assert_eq!(out.get_pixel(5, 5).0, [255, 0, 128]);
        // Gray + alpha.
        let la = image::GrayAlphaImage::from_fn(64, 64, |x, _| {
            image::LumaA([100, if x < 32 { 255 } else { 0 }])
        });
        let mut png = Vec::new();
        DynamicImage::ImageLumaA8(la)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let out = image::load_from_memory(&process_screenshot(&png).unwrap().full)
            .unwrap()
            .into_rgb8();
        assert_eq!(out.get_pixel(0, 0).0, [100, 100, 100]);
        assert_eq!(out.get_pixel(40, 0).0, [0, 0, 0]);
    }
}
