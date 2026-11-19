// F028: pure helpers for public profiles (link rules mirroring docs/API.md § F028 "Link rules", paths, limits).
// No React, no I/O.
// Note: this file is kept ASCII-only on purpose (non-ASCII code points are written as numbers below).

export const PROFILE_LINKS_MAX = 3;
export const PROFILE_LINK_LABEL_MAX = 30;
export const PROFILE_LINK_URL_MAX = 200;

/** Games shown on the Overview shelf. */
export const PROFILE_OVERVIEW_GAMES = 8;
/** Page size of the Games section. */
export const PROFILE_GAMES_PER_PAGE = 24;
/** Screenshots shown on the Overview shelf. */
export const PROFILE_SCREENSHOTS_PREVIEW = 4;

export const PROFILE_LINK_URL_MESSAGE = "Enter a full link starting with https:// or http://";

/** F030 adds "posts". */
export type ProfileSection = "posts" | "games" | "screenshots" | "collections";

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SCHEME = /^https?:\/\//i;
const AUTHORITY = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;

/**
 * The server's link URL rule (API § F028), on the trimmed value: at most 200 chars, printable ASCII only, `http://`
 * or `https://` (any case), then a `host[:port]` authority where the host is `[A-Za-z0-9.-]+`, contains a dot and
 * doesn't start or end with `.` or `-`, and the port is 1-5 digits. No credentials (`@`). Anything after the
 * authority must start with `/`, `?` or `#`.
 */
export function isSafeProfileUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const s = url.trim();
  if (!s || s.length > PROFILE_LINK_URL_MAX) return false;
  if (!PRINTABLE_ASCII.test(s)) return false;
  const scheme = SCHEME.exec(s);
  if (!scheme) return false;
  const rest = s.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const m = AUTHORITY.exec(authority);
  if (!m) return false;
  const host = m[1];
  if (!host.includes(".")) return false;
  if (/^[.-]/.test(host) || /[.-]$/.test(host)) return false;
  return true;
}

/**
 * The shared forbidden-character set (mirrors the server's `is_forbidden_label_char`), used for link labels, the
 * display name, the bio and post bodies: C0 controls (< 0x20) and DEL (0x7F), C1 controls (0x80-0x9F), zero-width
 * and directional marks (0x200B-0x200F), bidi embeddings/overrides (0x202A-0x202E), invisible operators
 * (0x2060-0x2064), bidi isolates (0x2066-0x2069) and the BOM (0xFEFF); since review 11 (L1/L2) also the Arabic
 * letter mark (0x061C), the Hangul fillers (0x115F, 0x1160, 0x3164, 0xFFA0), the Mongolian vowel separator (0x180E)
 * and the line and paragraph separators (0x2028, 0x2029).
 */
export function isForbiddenLabelCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    cp === 0xffa0
  );
}

/**
 * True when the RAW text (checked before any trim) contains a forbidden code point. With `allowNewline`, LF (0x0A)
 * is allowed (bio, post bodies); every other character of the set still is not.
 */
export function hasForbiddenProfileChar(text: string, allowNewline = false): boolean {
  const s = typeof text === "string" ? text : "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (allowNewline && cp === 0x0a) continue;
    if (isForbiddenLabelCodePoint(cp)) return true;
  }
  return false;
}

export const DISPLAY_NAME_CHARS_MESSAGE = "displayName must not contain control characters";
export const BIO_CHARS_MESSAGE = "bio must not contain control characters";

/** null when the display name has no forbidden character (raw text, before trim); else the server's message. */
export function validateDisplayName(raw: string): string | null {
  return hasForbiddenProfileChar(raw) ? DISPLAY_NAME_CHARS_MESSAGE : null;
}

/** null when the bio has no forbidden character other than LF (raw text, before trim); else the server's message. */
export function validateBio(raw: string): string | null {
  return hasForbiddenProfileChar(raw, true) ? BIO_CHARS_MESSAGE : null;
}

/** Unicode White_Space (what the server's trim strips). Unlike JS `trim()`, this excludes 0xFEFF. */
function isWhiteSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Trims Unicode White_Space only (the server's rule; a BOM at either end is kept, and then rejected). */
export function trimLinkLabel(label: string): string {
  const cps = Array.from(typeof label === "string" ? label : "");
  let start = 0;
  let end = cps.length;
  while (start < end && isWhiteSpace(cps[start].codePointAt(0)!)) start++;
  while (end > start && isWhiteSpace(cps[end - 1].codePointAt(0)!)) end--;
  return cps.slice(start, end).join("");
}

/**
 * null when the label is acceptable; else the server's message for link `index` (0-based).
 * - Forbidden characters are checked on the RAW label, before any trim, so e.g. a 0xFEFF or 0x85 at either end is
 *   rejected (trims differ between JS and the server; checking first keeps the client at least as strict).
 * - The length (at most {@link PROFILE_LINK_LABEL_MAX}) is counted in Unicode code points on the trimmed label.
 */
export function validateProfileLinkLabel(label: string, index: number): string | null {
  const raw = typeof label === "string" ? label : "";
  if (hasForbiddenProfileChar(raw)) return `links[${index}].label must not contain control characters`;
  if ([...trimLinkLabel(raw)].length > PROFILE_LINK_LABEL_MAX) return `links[${index}].label must be at most ${PROFILE_LINK_LABEL_MAX} characters`;
  return null;
}

/** null when `url` passes the server rule; else the inline Settings message. */
export function validateProfileLinkUrl(url: string): string | null {
  return isSafeProfileUrl(url) ? null : PROFILE_LINK_URL_MESSAGE;
}

/** The URL's hostname without a leading "www." ("" when it can't be parsed). */
export function linkHost(url: string): string {
  try {
    return new URL(url.trim()).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** In-app path of a profile or one of its sections: `/u/{username}[/{section}]`. */
export function profilePath(username: string, section?: ProfileSection): string {
  const base = `/u/${encodeURIComponent(username)}`;
  return section ? `${base}/${section}` : base;
}
