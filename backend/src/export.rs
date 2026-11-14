//! F013: build a zip of a game version's stored files (`GET /api/games/{id}/bundle`).
//!
//! The archive is plain zip (no ZIP64, encryption or data descriptors): `game.json` first,
//! then the other regular files sorted byte-wise by their `/`-separated relative path.
//! Precompressed formats are stored, everything else is deflated. Files are streamed into
//! the writer, and the in-memory output is capped at [`EXPORT_MAX_BYTES`].

use std::fs::File;
use std::io::{self, Cursor, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use zip::CompressionMethod;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;

/// Largest archive the server builds (uploads are at most 50 MB compressed).
pub const EXPORT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Extensions written with `CompressionMethod::Stored` (already compressed).
const STORED_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "mp3", "ogg", "woff2"];

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    /// The archive grew past the cap.
    #[error("the bundle is too large to download")]
    TooLarge,
    /// A file or directory disappeared while building (a concurrent replace).
    #[error("the version's files disappeared while building the archive")]
    Vanished,
    #[error("io: {0}")]
    Io(io::Error),
    #[error("zip: {0}")]
    Zip(String),
}

/// Marker carried inside the `io::Error` returned by [`CappedWriter`].
#[derive(Debug)]
struct CapExceeded;

impl std::fmt::Display for CapExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("export size cap exceeded")
    }
}

impl std::error::Error for CapExceeded {}

fn from_io(e: io::Error) -> ExportError {
    if e.get_ref().is_some_and(|inner| inner.is::<CapExceeded>()) {
        ExportError::TooLarge
    } else if e.kind() == io::ErrorKind::NotFound {
        ExportError::Vanished
    } else {
        ExportError::Io(e)
    }
}

fn from_zip(e: ZipError) -> ExportError {
    match e {
        ZipError::Io(e) => from_io(e),
        other => ExportError::Zip(other.to_string()),
    }
}

/// An in-memory `Write + Seek` buffer that fails once its length would exceed `cap`.
struct CappedWriter {
    inner: Cursor<Vec<u8>>,
    cap: usize,
}

impl Write for CappedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let end = (self.inner.position() as usize).saturating_add(buf.len());
        if end.max(self.inner.get_ref().len()) > self.cap {
            return Err(io::Error::other(CapExceeded));
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for CappedWriter {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

/// Regular files under `dir` as (relative `/` path, absolute path). Symlinks and anything
/// that is neither a regular file nor a directory are skipped.
fn collect_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, ExportError> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(dir.to_path_buf(), String::new())];
    while let Some((abs, rel)) = stack.pop() {
        for entry in std::fs::read_dir(&abs).map_err(from_io)? {
            let entry = entry.map_err(from_io)?;
            // Stored names come from validated bundle paths, so they are UTF-8; skip others.
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).map_err(from_io)?;
            let ft = meta.file_type();
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if ft.is_symlink() {
                continue;
            } else if ft.is_dir() {
                stack.push((path, child_rel));
            } else if ft.is_file() {
                out.push((child_rel, path));
            }
        }
    }
    // Byte-wise order, with `game.json` first.
    out.sort_by(|a, b| {
        (a.0 != "game.json")
            .cmp(&(b.0 != "game.json"))
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    Ok(out)
}

fn method_for(path: &str) -> CompressionMethod {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if STORED_EXTS.contains(&ext.as_str()) {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    }
}

/// Build the zip of `dir` (blocking; run it in `spawn_blocking`).
pub fn build_bundle_zip(dir: &Path, date: zip::DateTime) -> Result<Vec<u8>, ExportError> {
    build_bundle_zip_with_cap(dir, date, EXPORT_MAX_BYTES)
}

/// [`build_bundle_zip`] with an explicit output cap (tests use a small one).
pub fn build_bundle_zip_with_cap(
    dir: &Path,
    date: zip::DateTime,
    cap: usize,
) -> Result<Vec<u8>, ExportError> {
    let files = collect_files(dir)?;
    let mut zip = zip::ZipWriter::new(CappedWriter {
        inner: Cursor::new(Vec::new()),
        cap,
    });
    for (rel, abs) in files {
        let opts = SimpleFileOptions::default()
            .compression_method(method_for(&rel))
            .last_modified_time(date);
        let mut file = File::open(&abs).map_err(from_io)?;
        zip.start_file(rel, opts).map_err(from_zip)?;
        io::copy(&mut file, &mut zip).map_err(from_io)?;
    }
    let w = zip.finish().map_err(from_zip)?;
    Ok(w.inner.into_inner())
}

/// The zip entry date for an RFC 3339 timestamp, in UTC, clamped to the zip range
/// (1980-01-01 to 2107-12-31). `None` when the timestamp doesn't parse.
pub fn zip_date(rfc3339: &str) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let t = chrono::DateTime::parse_from_rfc3339(rfc3339)
        .ok()?
        .with_timezone(&chrono::Utc);
    if t.year() < 1980 {
        return zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).ok();
    }
    if t.year() > 2107 {
        return zip::DateTime::from_date_and_time(2107, 12, 31, 23, 59, 58).ok();
    }
    zip::DateTime::from_date_and_time(
        t.year() as u16,
        t.month() as u8,
        t.day() as u8,
        t.hour() as u8,
        t.minute() as u8,
        t.second().min(58) as u8,
    )
    .ok()
}

/// ASCII slug for the download file name: lowercase, runs of anything other than
/// `[a-z0-9]` become `-`, trimmed of `-`, at most 40 chars, `game` when empty.
pub fn download_slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-');
    let cut: String = trimmed.chars().take(40).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() {
        "game".to_string()
    } else {
        cut.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn date() -> zip::DateTime {
        zip::DateTime::from_date_and_time(2026, 11, 14, 12, 30, 10).unwrap()
    }

    fn write(dir: &Path, rel: &str, data: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    fn entries(bytes: Vec<u8>) -> Vec<(String, CompressionMethod, Vec<u8>)> {
        let mut a = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..a.len())
            .map(|i| {
                let mut f = a.by_index(i).unwrap();
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                (f.name().to_string(), f.compression(), data)
            })
            .collect()
    }

    #[test]
    fn order_methods_and_dates() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "main.js", b"export default {};");
        write(dir.path(), "game.json", b"{}");
        write(dir.path(), "assets/b.PNG", b"\x89PNG");
        write(dir.path(), "assets/a.ogg", b"OggS");
        write(dir.path(), "Z.txt", b"z");
        let out = build_bundle_zip(dir.path(), date()).unwrap();
        let mut a = zip::ZipArchive::new(Cursor::new(out.clone())).unwrap();
        assert_eq!(a.by_index(0).unwrap().last_modified(), Some(date()));
        let e = entries(out);
        let names: Vec<&str> = e.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "game.json",
                "Z.txt",
                "assets/a.ogg",
                "assets/b.PNG",
                "main.js"
            ]
        );
        assert_eq!(e[2].1, CompressionMethod::Stored);
        assert_eq!(e[3].1, CompressionMethod::Stored);
        assert_eq!(e[4].1, CompressionMethod::Deflated);
        assert_eq!(e[4].2, b"export default {};");
    }

    #[test]
    fn missing_dir_is_vanished() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("v1");
        assert!(matches!(
            build_bundle_zip(&gone, date()),
            Err(ExportError::Vanished)
        ));
        let e = io::Error::new(io::ErrorKind::NotFound, "gone");
        assert!(matches!(from_io(e), ExportError::Vanished));
        assert!(matches!(
            from_zip(ZipError::Io(io::Error::new(io::ErrorKind::NotFound, "x"))),
            ExportError::Vanished
        ));
    }

    #[test]
    fn cap_triggers_too_large() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "game.json", b"{}");
        // Stored, so the output is at least as large as the input.
        write(dir.path(), "big.png", &vec![7u8; 64 * 1024]);
        assert!(matches!(
            build_bundle_zip_with_cap(dir.path(), date(), 32 * 1024),
            Err(ExportError::TooLarge)
        ));
        assert!(build_bundle_zip_with_cap(dir.path(), date(), 256 * 1024).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(dir.path(), "game.json", b"{}");
        write(outside.path(), "secret.txt", b"secret");
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linkdir")).unwrap();
        let names: Vec<String> = entries(build_bundle_zip(dir.path(), date()).unwrap())
            .into_iter()
            .map(|(n, _, _)| n)
            .collect();
        assert_eq!(names, ["game.json"]);
    }

    #[test]
    fn dates_are_clamped() {
        assert_eq!(
            zip_date("2026-11-14T12:30:11.123Z"),
            zip::DateTime::from_date_and_time(2026, 11, 14, 12, 30, 11).ok()
        );
        assert_eq!(
            zip_date("2026-11-14T23:30:00-02:00"),
            zip::DateTime::from_date_and_time(2026, 11, 15, 1, 30, 0).ok()
        );
        assert_eq!(
            zip_date("1970-01-01T00:00:00Z"),
            zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).ok()
        );
        assert_eq!(
            zip_date("2200-01-01T00:00:00Z"),
            zip::DateTime::from_date_and_time(2107, 12, 31, 23, 59, 58).ok()
        );
        assert_eq!(zip_date("nope"), None);
    }

    #[test]
    fn slugs() {
        assert_eq!(download_slug("Space Dodge!"), "space-dodge");
        assert_eq!(download_slug("  --Ünïcode__Game 2-- "), "n-code-game-2");
        assert_eq!(download_slug("日本語"), "game");
        assert_eq!(download_slug(""), "game");
        let long = download_slug(&"ab ".repeat(30));
        assert!(long.len() <= 40 && !long.ends_with('-'), "{long}");
    }
}
