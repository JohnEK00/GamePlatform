//! F004 release notes: parsing/validation shared by create, bundle replace and notes edits
//! (docs/API.md § F004 additions, "Notes rules").

use crate::error::{AppError, AppResult};

/// Maximum notes length in Unicode scalar values, after normalisation.
pub const NOTES_MAX: usize = 1000;
/// Maximum raw size of a multipart `notes` field.
pub const NOTES_RAW_MAX: usize = 8 * 1024;

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Normalise and validate release notes.
///
/// `\r\n` / `\r` → `\n`, trim, collapse runs of 3+ blank lines to 2, then enforce
/// [`NOTES_MAX`] and reject control characters (other than `\n`, `\t`) and bidi controls.
pub fn parse_notes(raw: &str) -> AppResult<String> {
    let normalised = raw.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalised.trim();

    let mut lines: Vec<&str> = Vec::new();
    let mut blank_run = 0usize;
    for line in trimmed.split('\n') {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 2 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        lines.push(line);
    }
    let notes = lines.join("\n");

    if notes.chars().count() > NOTES_MAX {
        return Err(AppError::validation(format!(
            "notes must be at most {NOTES_MAX} characters"
        )));
    }
    if notes
        .chars()
        .any(|c| (c.is_control() && c != '\n' && c != '\t') || is_bidi_control(c))
    {
        return Err(AppError::validation("notes contain invalid characters"));
    }
    Ok(notes)
}

/// A decimal positive integer (surrounding whitespace allowed), else 400 `bad_request`
/// "{name} must be a positive integer".
pub fn parse_positive(raw: &str, name: &str) -> AppResult<i64> {
    let s = raw.trim();
    match s.parse::<i64>() {
        Ok(n) if n > 0 && s.bytes().all(|b| b.is_ascii_digit()) => Ok(n),
        _ => Err(AppError::BadRequest(format!(
            "{name} must be a positive integer"
        ))),
    }
}

/// Read a multipart `notes` field (at most [`NOTES_RAW_MAX`] bytes raw) and parse it.
pub async fn read_notes_field(mut field: axum::extract::multipart::Field<'_>) -> AppResult<String> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = field.chunk().await? {
        if buf.len() + chunk.len() > NOTES_RAW_MAX {
            return Err(AppError::validation("notes field must be at most 8 KB"));
        }
        buf.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(buf)
        .map_err(|_| AppError::validation("notes contain invalid characters"))?;
    parse_notes(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises() {
        assert_eq!(parse_notes("").unwrap(), "");
        assert_eq!(parse_notes("  a\r\nb\rc  \n").unwrap(), "a\nb\nc");
        assert_eq!(parse_notes("a\n\n\n\n\nb").unwrap(), "a\n\n\nb");
        assert_eq!(parse_notes("a\n\n\nb").unwrap(), "a\n\n\nb");
        assert_eq!(parse_notes("a\tb").unwrap(), "a\tb");
    }

    #[test]
    fn rejects() {
        assert!(parse_notes(&"x".repeat(1000)).is_ok());
        assert!(parse_notes(&"é".repeat(1000)).is_ok());
        assert!(parse_notes(&"x".repeat(1001)).is_err());
        assert!(parse_notes("a\0b").is_err());
        assert!(parse_notes("a\u{202E}b").is_err());
        assert!(parse_notes("a\u{2066}b").is_err());
        assert!(parse_notes("a\u{7}b").is_err());
    }
}
