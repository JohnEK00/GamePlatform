import { createZip, createZipAsync } from "./zip";
import { readZip, type ReadZipLimits } from "./unzip";

/**
 * A Studio project: the game.json object plus bundle files keyed by bundle-relative path ("main.js", "assets/x.png").
 * Text files are strings, binary files ArrayBuffers. `game.json` itself lives in `manifest`, not in `files`.
 * Hosts can supply one via `platform.openLocalProject` (see docs/ARCHITECTURE.md "v2 features").
 */
export type StudioProject = {
  manifest: object;
  files: Record<string, string | ArrayBuffer>;
};

export type StudioAchievement = { id: string; name: string; description?: string; icon?: string };

/** The game.json fields the Studio form edits. Unknown fields are preserved. */
export type StudioManifest = {
  name?: string;
  entry?: string;
  width?: number;
  height?: number;
  engine?: string;
  achievements?: StudioAchievement[];
  /** F001: optional leaderboard semantics (GAME_FORMAT.md § F001). */
  leaderboard?: StudioLeaderboard;
  [key: string]: unknown;
};

/** F001: game.json `leaderboard` block. Every key is optional. */
export type StudioLeaderboard = { order?: "desc" | "asc"; format?: "number" | "time"; label?: string };

export const LEADERBOARD_LABEL_MAX = 24;

/** F001: the effective leaderboard config of a manifest (defaults for absent/invalid values). */
export function leaderboardOf(manifest: object | null | undefined): { order: "desc" | "asc"; format: "number" | "time"; label: string } {
  const lb = asManifest(manifest).leaderboard as unknown;
  const o = lb && typeof lb === "object" && !Array.isArray(lb) ? (lb as Record<string, unknown>) : {};
  return {
    order: o.order === "asc" ? "asc" : "desc",
    format: o.format === "time" ? "time" : "number",
    label: typeof o.label === "string" ? o.label.trim().slice(0, LEADERBOARD_LABEL_MAX) : "",
  };
}

/**
 * F001: returns a copy of the manifest with `leaderboard` set from `patch` merged onto the current values.
 * Default values are left out, and the key is omitted entirely when everything is default.
 */
export function withLeaderboard(manifest: object, patch: StudioLeaderboard): StudioManifest {
  const m = asManifest(manifest);
  const cur = leaderboardOf(m);
  const prevLabel = (m.leaderboard as { label?: unknown } | undefined)?.label;
  const rawLabel = patch.label !== undefined ? patch.label : typeof prevLabel === "string" ? prevLabel : "";
  const next = { order: patch.order ?? cur.order, format: patch.format ?? cur.format, label: String(rawLabel).slice(0, LEADERBOARD_LABEL_MAX) };
  const out: StudioLeaderboard = {};
  if (next.order !== "desc") out.order = next.order;
  if (next.format !== "number") out.format = next.format;
  if (next.label.trim() !== "") out.label = next.label;
  if (Object.keys(out).length) m.leaderboard = out;
  else delete m.leaderboard;
  return m;
}

export const ALLOWED_EXTENSIONS = ["json", "js", "png", "jpg", "jpeg", "webp", "gif", "svg", "txt", "wav", "mp3", "ogg", "css", "woff2", "ttf"];
export const TEXT_EXTENSIONS = ["js", "json", "txt", "css", "svg", "md", "csv"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
export const MAX_PROJECT_FILES = 2000;
/** Backend bundle limits (GAME_FORMAT.md, backend/src/bundle.rs). */
export const MAX_BUNDLE_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_BUNDLE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const ACHIEVEMENT_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}

export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.includes(extOf(path));
}

/** Normalises a bundle path: forward slashes, no leading "./" or "/", no empty / "." segments. Returns null if invalid. */
export function normalizeProjectPath(p: string): string | null {
  const parts = p.trim().replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export function asManifest(m: object | null | undefined): StudioManifest {
  return m && typeof m === "object" && !Array.isArray(m) ? ({ ...(m as Record<string, unknown>) } as StudioManifest) : {};
}

/** Validates the project the way the backend will (GAME_FORMAT.md). Returns human-readable problems. */
export function validateProject(project: StudioProject): string[] {
  const m = asManifest(project.manifest);
  const errs: string[] = [];
  if (typeof m.name !== "string" || !m.name.trim()) errs.push("game.json: name is required.");
  if (typeof m.entry !== "string" || !m.entry) errs.push("game.json: entry is required.");
  else if (!/\.js$/i.test(m.entry)) errs.push("game.json: entry must be a .js file.");
  else if (!(m.entry in project.files) && !((normalizeProjectPath(m.entry) ?? "") in project.files))
    errs.push(`game.json: entry "${m.entry}" doesn't exist in the project.`);
  for (const k of ["width", "height"] as const) {
    const v = m[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 64 || v > 4096) errs.push(`game.json: ${k} must be an integer from 64 to 4096.`);
  }
  if (m.achievements !== undefined) {
    if (!Array.isArray(m.achievements)) errs.push("game.json: achievements must be a list.");
    else {
      if (m.achievements.length > 50) errs.push("game.json: at most 50 achievements.");
      const ids = new Set<string>();
      m.achievements.forEach((a, i) => {
        const label = `achievement #${i + 1}`;
        if (!a || typeof a !== "object") return errs.push(`${label} is not an object.`);
        if (typeof a.id !== "string" || !ACHIEVEMENT_ID_PATTERN.test(a.id)) errs.push(`${label}: id must match a-z 0-9 _ - (1–32 chars).`);
        else if (ids.has(a.id)) errs.push(`${label}: duplicate id "${a.id}".`);
        else ids.add(a.id);
        if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 60) errs.push(`${label}: name must be 1–60 characters.`);
        if (a.description !== undefined && (typeof a.description !== "string" || a.description.length > 200))
          errs.push(`${label}: description must be at most 200 characters.`);
        if (a.icon !== undefined && a.icon !== "" && !(typeof a.icon === "string" && a.icon in project.files))
          errs.push(`${label}: icon "${String(a.icon)}" doesn't exist in the project.`);
      });
    }
  }
  if (m.leaderboard !== undefined) {
    const lb = m.leaderboard as unknown;
    if (!lb || typeof lb !== "object" || Array.isArray(lb)) errs.push("game.json: leaderboard must be an object.");
    else {
      const o = lb as Record<string, unknown>;
      if (o.order !== undefined && o.order !== "desc" && o.order !== "asc") errs.push('game.json: leaderboard.order must be "desc" or "asc".');
      if (o.format !== undefined && o.format !== "number" && o.format !== "time") errs.push('game.json: leaderboard.format must be "number" or "time".');
      if (o.label !== undefined && (typeof o.label !== "string" || o.label.trim().length > LEADERBOARD_LABEL_MAX))
        errs.push(`game.json: leaderboard.label must be text of at most ${LEADERBOARD_LABEL_MAX} characters.`);
    }
  }
  const paths = Object.keys(project.files);
  if (paths.length + 1 > MAX_PROJECT_FILES) errs.push(`Too many files (max ${MAX_PROJECT_FILES}).`);
  for (const p of paths) if (!ALLOWED_EXTENSIONS.includes(extOf(p))) errs.push(`"${p}": file type not allowed in bundles.`);
  errs.push(...validateBundlePaths(paths));
  const size = projectSize(project);
  if (size > MAX_BUNDLE_UNCOMPRESSED_BYTES)
    errs.push(`The project is ${formatMB(size)} uncompressed; bundles may be at most ${formatMB(MAX_BUNDLE_UNCOMPRESSED_BYTES)}.`);
  return errs;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const formatMB = (n: number) => `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

/**
 * Path problems the backend rejects (bundle.rs): invalid paths, case-insensitive duplicates (including a
 * second "game.json"), and a file whose path is also used as a folder ("x" and "x/y").
 */
export function validateBundlePaths(paths: string[]): string[] {
  const errs: string[] = [];
  const byLower = new Map<string, string>([["game.json", "game.json"]]);
  const normalized: string[] = [];
  for (const p of paths) {
    const n = normalizeProjectPath(p);
    if (!n) {
      errs.push(`"${p}": invalid file path.`);
      continue;
    }
    const lower = asciiLower(n);
    const prev = byLower.get(lower);
    if (prev !== undefined) errs.push(`"${n}" clashes with "${prev}" (file names are case-insensitive in bundles).`);
    else {
      byLower.set(lower, n);
      normalized.push(n);
    }
  }
  const dirs = new Map<string, string>();
  for (const n of normalized) {
    const segs = n.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = asciiLower(segs.slice(0, i).join("/"));
      if (!dirs.has(d)) dirs.set(d, n);
    }
  }
  for (const n of [...normalized, "game.json"]) {
    const child = dirs.get(asciiLower(n));
    if (child !== undefined) errs.push(`"${n}" is a file but "${child}" uses it as a folder.`);
  }
  return errs;
}

/**
 * Maps the `file` of a `webgame:error` (a bundle-relative path, or a URL ending in one) to a path in the
 * project's files. Returns null when it can't be matched (callers then fall back to the entry).
 */
export function resolveProjectFile(files: Record<string, unknown>, file: string | null | undefined): string | null {
  if (typeof file !== "string" || !file.trim()) return null;
  if (file in files) return file;
  const direct = normalizeProjectPath(file);
  if (direct && direct in files) return direct;
  let path = file;
  if (/^[a-z][a-z0-9+.-]*:/i.test(file)) {
    try {
      path = new URL(file).pathname;
    } catch {
      return null;
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it encoded */
  }
  let best: string | null = null;
  for (const p of Object.keys(files)) {
    if ((path === p || path.endsWith(`/${p}`)) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** Byte size of one project file (strings are measured as UTF-8). */
export function fileSize(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
}

/** Total uncompressed size of the bundle the project produces (game.json included). */
export function projectSize(project: StudioProject): number {
  let n = fileSize(JSON.stringify(manifestForBundle(project.manifest), null, 2) + "\n");
  for (const [p, d] of Object.entries(project.files)) if (p !== "game.json") n += fileSize(d);
  return n;
}

/** Problem with a built bundle's (compressed) size, or null when it is within the upload limit. */
export function checkBundleSize(bundle: Blob | Uint8Array): string | null {
  const n = bundle instanceof Uint8Array ? bundle.length : bundle.size;
  return n > MAX_BUNDLE_COMPRESSED_BYTES
    ? `The bundle is ${formatMB(n)} compressed; uploads may be at most ${formatMB(MAX_BUNDLE_COMPRESSED_BYTES)}.`
    : null;
}

/** game.json as written into bundles: empty achievement icons/descriptions are dropped. */
export function manifestForBundle(manifest: object): StudioManifest {
  const m = asManifest(manifest);
  if (Array.isArray(m.achievements)) {
    if (m.achievements.length === 0) delete m.achievements;
    else
      m.achievements = m.achievements.map((a) => {
        const out: StudioAchievement = { id: a.id, name: a.name };
        if (a.description) out.description = a.description;
        if (a.icon) out.icon = a.icon;
        return out;
      });
  }
  return m;
}

function bundleFiles(project: StudioProject): Record<string, string | ArrayBuffer> {
  const files: Record<string, string | ArrayBuffer> = { "game.json": JSON.stringify(manifestForBundle(project.manifest), null, 2) + "\n" };
  for (const [p, d] of Object.entries(project.files)) if (p !== "game.json") files[p] = d;
  return files;
}

/** Builds the bundle .zip (game.json at the root + all files), store-only. */
export function buildBundleZip(project: StudioProject): Blob {
  return new Blob([createZip(bundleFiles(project))], { type: "application/zip" });
}

/**
 * Builds the bundle .zip DEFLATE-compressed where the runtime has `CompressionStream("deflate-raw")`
 * (store-only otherwise). Use it for uploads and exports: the backend's 50 MB limit is on the compressed size.
 */
export async function buildBundleZipAsync(project: StudioProject, opts: { compression?: "deflate" | "store" } = {}): Promise<Blob> {
  return new Blob([await createZipAsync(bundleFiles(project), { compression: opts.compression })], { type: "application/zip" });
}

// ---------- autosave (localStorage) ----------

export const STUDIO_STORAGE_KEY = "webgame.studio.project";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/**
 * F013: which game a Studio project was downloaded from or last published to. Kept next to the project
 * (never inside `StudioProject`, which is the host contract). A link whose `apiBase` differs from the
 * current `apiBaseUrl` is ignored (not deleted).
 */
export type StudioLink = { gameId: string; title: string; version: number; apiBase: string };

/** F013: the Studio's working state: the project plus its link and whether it was edited since the last load/publish. */
export type StudioSession = { project: StudioProject; link?: StudioLink; dirty: boolean };

/**
 * F013: a project from a host's local folder (desktop). `localFolder.id` is an opaque, session-scoped handle
 * for `platform.reloadLocalProject`; `name` is for display only. Never autosaved.
 */
export type LocalProject = StudioProject & { localFolder?: { id: string; name: string } };

/** F013: a well-formed link, or null. */
export function parseStudioLink(v: unknown): StudioLink | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.gameId !== "string" || !o.gameId) return null;
  if (typeof o.title !== "string") return null;
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) return null;
  if (typeof o.apiBase !== "string") return null;
  return { gameId: o.gameId, title: o.title, version: o.version, apiBase: o.apiBase };
}

/** Autosave format `v: 1`. F013: optional top-level `link` and `dirty`. */
export function serializeProject(p: StudioProject, meta: { link?: StudioLink | null; dirty?: boolean } = {}): string {
  const files: Record<string, { t: string } | { b: string }> = {};
  for (const [k, v] of Object.entries(p.files)) files[k] = typeof v === "string" ? { t: v } : { b: toBase64(v) };
  const out: Record<string, unknown> = { v: 1, manifest: p.manifest, files };
  if (meta.link) out.link = meta.link;
  if (meta.dirty !== undefined) out.dirty = meta.dirty;
  return JSON.stringify(out);
}

/** F013: reads an autosave with its link (a malformed one is dropped) and dirty flag (missing → false). */
export function deserializeSession(json: string): StudioSession | null {
  try {
    const o = JSON.parse(json) as { manifest?: unknown; files?: Record<string, { t?: string; b?: string }>; link?: unknown; dirty?: unknown };
    if (!o || typeof o !== "object" || !o.manifest || typeof o.manifest !== "object" || !o.files || typeof o.files !== "object") return null;
    const files: StudioProject["files"] = {};
    for (const [k, v] of Object.entries(o.files)) {
      if (typeof v?.t === "string") files[k] = v.t;
      else if (typeof v?.b === "string") files[k] = fromBase64(v.b);
    }
    const session: StudioSession = { project: { manifest: o.manifest as object, files }, dirty: o.dirty === true };
    const link = parseStudioLink(o.link);
    if (link) session.link = link;
    return session;
  } catch {
    return null;
  }
}

export function deserializeProject(json: string): StudioProject | null {
  return deserializeSession(json)?.project ?? null;
}

/** Saves to localStorage. Returns false if storage is unavailable or full. */
export function saveProjectToStorage(p: StudioProject, meta: { link?: StudioLink | null; dirty?: boolean } = {}): boolean {
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, serializeProject(p, meta));
    return true;
  } catch {
    return false;
  }
}

export function loadProjectFromStorage(): StudioProject | null {
  return loadSessionFromStorage()?.project ?? null;
}

/** F013: the autosaved session (project + link + dirty), or null. */
export function loadSessionFromStorage(): StudioSession | null {
  try {
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    return raw ? deserializeSession(raw) : null;
  } catch {
    return null;
  }
}

// ---------- import from a folder (<input webkitdirectory>) or a .zip ----------

/** One file of an import source; `read` is only called for files the project keeps. */
export type ProjectEntry = { path: string; read(): Promise<Uint8Array | string> };

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength && u8.buffer instanceof ArrayBuffer ? u8.buffer : u8.slice().buffer;
}

/** UTF-8 decode that keeps a leading BOM (so it survives a round trip). */
function decodeText(d: Uint8Array | string): string {
  return typeof d === "string" ? d : new TextDecoder("utf-8", { ignoreBOM: true }).decode(d);
}

/**
 * Shared import rules for folders and .zip files: strips a single common top-level folder only when it holds
 * `game.json` (the backend rule), parses game.json, keeps text files as strings and everything else as
 * ArrayBuffers, skips dotfiles (silently) and disallowed extensions (reported in `skipped`), caps the file
 * count, and throws if game.json is missing or invalid JSON.
 */
export async function projectFromEntries(
  entries: ProjectEntry[],
  source: "folder" | "zip" = "folder",
): Promise<{ project: StudioProject; skipped: string[] }> {
  const items = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, "/").replace(/^\/+/, "") }));
  if (!items.length) throw new Error(source === "zip" ? "The .zip is empty." : "The folder is empty.");
  const firstSeg = (p: string) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : null);
  const top = firstSeg(items[0].path);
  const strip =
    top !== null && items.every((i) => firstSeg(i.path) === top) && items.some((i) => normalizeProjectPath(i.path.slice(top.length + 1)) === "game.json");
  const skipped: string[] = [];
  const files: StudioProject["files"] = {};
  let count = 0;
  let manifest: object | null = null;
  for (const item of items) {
    const rel = normalizeProjectPath(strip ? item.path.slice(top!.length + 1) : item.path);
    if (!rel || rel.split("/").some((s) => s.startsWith("."))) continue;
    if (rel === "game.json") {
      try {
        const parsed: unknown = JSON.parse(decodeText(await item.read()).replace(/^﻿/, ""));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        manifest = parsed as object;
      } catch {
        throw new Error("game.json is not a valid JSON object.");
      }
      continue;
    }
    if (!ALLOWED_EXTENSIONS.includes(extOf(rel)) || count >= MAX_PROJECT_FILES) {
      skipped.push(rel);
      continue;
    }
    const data = await item.read();
    files[rel] = isTextPath(rel) ? decodeText(data) : typeof data === "string" ? toArrayBuffer(new TextEncoder().encode(data)) : toArrayBuffer(data);
    count++;
  }
  if (!manifest) throw new Error(source === "zip" ? "No game.json found at the top of the .zip." : "No game.json found at the top of the folder.");
  return { project: { manifest, files }, skipped };
}

/**
 * Reads a folder selection into a project (see {@link projectFromEntries} for the rules).
 */
export async function projectFromFileList(list: ArrayLike<File>): Promise<{ project: StudioProject; skipped: string[] }> {
  const entries: ProjectEntry[] = Array.from(list).map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    read: async () => new Uint8Array(await f.arrayBuffer()),
  }));
  return projectFromEntries(entries, "folder");
}

/** F013: reads a bundle .zip into a project with {@link readZip} + {@link projectFromEntries}. */
export async function projectFromZip(data: ArrayBuffer | Uint8Array, limits?: ReadZipLimits): Promise<{ project: StudioProject; skipped: string[] }> {
  const entries = await readZip(data, limits);
  return projectFromEntries(
    entries.map((e) => ({ path: e.path, read: async () => e.data })),
    "zip",
  );
}

/** Starts a browser download of a blob (no-op where downloads are unsupported). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "game";
}
