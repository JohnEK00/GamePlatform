// F030: pure helpers for user posts (body rules mirroring docs/API.md section F030 "Body rules", linkify, paths).
// No React, no I/O.
// Note: this file is kept ASCII-only on purpose (non-ASCII code points are written as numbers).

import type { Post, PostAttachmentType, PostReply } from "./api/types";
import { isForbiddenLabelCodePoint, isSafeProfileUrl } from "./profile";

/** Code points per post (server: 1-500). */
export const POST_BODY_MAX = 500;
/** Lines per post (at most 11 "\n"). */
export const POST_LINES_MAX = 12;
/** Page size of the profile Posts section. */
export const POSTS_PER_PAGE = 20;
/** Posts shown on the profile Overview shelf. */
export const PROFILE_POSTS_PREVIEW = 3;

export const POST_LINES_MESSAGE = "Posts can have at most 12 lines.";
export const POST_CHARS_MESSAGE = "Remove tabs, control characters and invisible formatting characters.";

const LF = 0x0a;

/** CRLF and CR become LF, then the text is trimmed (the server's step 1). */
export function normalizePostBody(raw: string): string {
  const s = typeof raw === "string" ? raw : "";
  return s.replace(/\r\n?/g, "\n").trim();
}

/** Code points of the normalised, trimmed text (what the server's 1-500 rule counts). */
export function postLength(raw: string): number {
  return Array.from(normalizePostBody(raw)).length;
}

/**
 * null when the body passes the client checks; else the composer's message. In order:
 * 1. more than {@link POST_LINES_MAX} lines (counted on the normalised text);
 * 2. a forbidden character other than LF, checked on the RAW text (before any trim, as F028 does, so the client is
 *    at least as strict as the server). Since review 11 (L2) the set includes U+2028 and U+2029, so a body can't
 *    bypass the line cap with LINE / PARAGRAPH SEPARATOR breaks.
 * The 1-500 length rule is enforced by the disabled Post button, not here. F031: replies pass
 * {@link REPLY_LINES_MESSAGE} as `linesMessage`.
 */
export function validatePostBody(raw: string, linesMessage: string = POST_LINES_MESSAGE): string | null {
  const s = typeof raw === "string" ? raw : "";
  const body = normalizePostBody(s);
  if (body.split("\n").length > POST_LINES_MAX) return linesMessage;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp !== LF && isForbiddenLabelCodePoint(cp)) return POST_CHARS_MESSAGE;
  }
  return null;
}

export type PostSegment = { type: "text"; text: string } | { type: "link"; text: string; href: string };

const URL_CANDIDATE = /https?:\/\/\S+/gi;
const OPENERS = "([{<\"'";
const TRAILING = ".,:;!?'\"]}>";

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Spec section 0.4 step 2: strip trailing punctuation and an unbalanced final ")". */
function trimCandidate(url: string): string {
  let s = url;
  for (;;) {
    const last = s.charAt(s.length - 1);
    if (last && TRAILING.includes(last)) {
      s = s.slice(0, -1);
    } else if (last === ")" && count(s, ")") > count(s, "(")) {
      s = s.slice(0, -1);
    } else {
      return s;
    }
  }
}

function isBoundary(body: string, index: number): boolean {
  if (index === 0) return true;
  const prev = body.charAt(index - 1);
  return /\s/.test(prev) || OPENERS.includes(prev);
}

/**
 * Splits a post body into text and link segments (spec section 0.4). A link is a `https?://` run of non-whitespace at
 * the start of the body or after whitespace or one of `( [ { < " '`, with trailing `. , : ; ! ? ' " ] } >` and an
 * unbalanced final `)` removed, that passes {@link isSafeProfileUrl}. Removed characters go back into the following
 * text. Everything else (bare domains, @mentions, #tags, unsafe URLs) stays text. Adjacent text is merged.
 */
export function linkifyPost(body: string): PostSegment[] {
  const s = typeof body === "string" ? body : "";
  const out: PostSegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.text += text;
    else out.push({ type: "text", text });
  };
  let pos = 0;
  URL_CANDIDATE.lastIndex = 0;
  for (let m = URL_CANDIDATE.exec(s); m; m = URL_CANDIDATE.exec(s)) {
    const start = m.index;
    const match = m[0];
    if (!isBoundary(s, start)) continue;
    const url = trimCandidate(match);
    if (!isSafeProfileUrl(url)) continue;
    pushText(s.slice(pos, start));
    out.push({ type: "link", text: url, href: url });
    pos = start + url.length;
  }
  pushText(s.slice(pos));
  return out;
}

/** In-app permalink of a post: `/p/{id}`. */
export function postPath(id: string): string {
  return `/p/${encodeURIComponent(id)}`;
}

export type PostAttachRef = { type: PostAttachmentType; id: string };

/** `?attach=` value: `game:{id}` or `collection:{id}` (id non-empty); anything else is null. */
export function parseAttachParam(v: string | null | undefined): PostAttachRef | null {
  if (typeof v !== "string") return null;
  const colon = v.indexOf(":");
  if (colon < 0) return null;
  const type = v.slice(0, colon);
  const id = v.slice(colon + 1);
  if (!id) return null;
  if (type !== "game" && type !== "collection") return null;
  return { type, id };
}

/** `/u/{username}/posts?attach={type}:{id}`: the own Posts section with the composer's attachment prefilled. */
export function postComposePath(username: string, attach: PostAttachRef): string {
  return `/u/${encodeURIComponent(username)}/posts?attach=${attach.type}:${encodeURIComponent(attach.id)}`;
}

/** A post is usable when it has string `id`, `body` and `createdAt` and an `author` with a string `username`. */
export function isValidPost(x: unknown): x is Post {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.body !== "string" || typeof p.createdAt !== "string") return false;
  const a = p.author as Record<string, unknown> | null | undefined;
  return !!a && typeof a === "object" && typeof a.username === "string";
}

// ---------- F031: replies and hearts ----------

/** Replies per post (server cap; also the page maximum, so the whole thread loads in one request). */
export const POST_REPLY_CAP = 200;
export const REPLY_LINES_MESSAGE = "Replies can have at most 12 lines.";

/** `/p/{postId}?reply={replyId}`: the permalink with that reply highlighted. */
export function postReplyPath(postId: string, replyId: string): string {
  return `${postPath(postId)}?reply=${encodeURIComponent(replyId)}`;
}

/** The replies link text on a post card: `Reply`, `1 reply`, `{n} replies`. */
export function repliesLinkText(n: number): string {
  const k = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (k === 0) return "Reply";
  return k === 1 ? "1 reply" : `${k} replies`;
}

/** The replies link's accessible name: `Reply to the post by {name}`, `1 reply to ...`, `{n} replies to ...`. */
export function repliesLinkLabel(n: number, name: string): string {
  return `${repliesLinkText(n)} to the post by ${name}`;
}

/** The server sends the F031 fields (hearts and replyCount): show hearts and replies. */
export function hasPostSocial(post: Pick<Post, "hearts" | "replyCount"> | null | undefined): boolean {
  return !!post && typeof post.hearts === "number" && typeof post.replyCount === "number";
}

/** A reply is usable when it has string `id`, `postId`, `body`, `createdAt` and `path` and an author with a username. */
export function isValidPostReply(x: unknown): x is PostReply {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  for (const k of ["id", "postId", "body", "createdAt", "path"]) if (typeof r[k] !== "string") return false;
  const a = r.author as Record<string, unknown> | null | undefined;
  return !!a && typeof a === "object" && typeof a.username === "string";
}
