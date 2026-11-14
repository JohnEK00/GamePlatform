import { createZip } from "./zip";

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
  return errs;
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

/** Builds the bundle .zip (game.json at the root + all files). */
export function buildBundleZip(project: StudioProject): Blob {
  const files: Record<string, string | ArrayBuffer> = { "game.json": JSON.stringify(manifestForBundle(project.manifest), null, 2) + "\n" };
  for (const [p, d] of Object.entries(project.files)) if (p !== "game.json") files[p] = d;
  return new Blob([createZip(files)], { type: "application/zip" });
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

export function serializeProject(p: StudioProject): string {
  const files: Record<string, { t: string } | { b: string }> = {};
  for (const [k, v] of Object.entries(p.files)) files[k] = typeof v === "string" ? { t: v } : { b: toBase64(v) };
  return JSON.stringify({ v: 1, manifest: p.manifest, files });
}

export function deserializeProject(json: string): StudioProject | null {
  try {
    const o = JSON.parse(json) as { manifest?: unknown; files?: Record<string, { t?: string; b?: string }> };
    if (!o || typeof o !== "object" || !o.manifest || typeof o.manifest !== "object" || !o.files) return null;
    const files: StudioProject["files"] = {};
    for (const [k, v] of Object.entries(o.files)) {
      if (typeof v?.t === "string") files[k] = v.t;
      else if (typeof v?.b === "string") files[k] = fromBase64(v.b);
    }
    return { manifest: o.manifest as object, files };
  } catch {
    return null;
  }
}

/** Saves to localStorage. Returns false if storage is unavailable or full. */
export function saveProjectToStorage(p: StudioProject): boolean {
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, serializeProject(p));
    return true;
  } catch {
    return false;
  }
}

export function loadProjectFromStorage(): StudioProject | null {
  try {
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    return raw ? deserializeProject(raw) : null;
  } catch {
    return null;
  }
}

// ---------- import from a folder (<input webkitdirectory>) ----------

/**
 * Reads a folder selection into a project: strips a single common top-level folder, parses game.json, keeps
 * text files as strings and everything else as ArrayBuffers. Skips files with disallowed extensions and
 * dotfiles. Throws if game.json is missing or invalid JSON.
 */
export async function projectFromFileList(list: ArrayLike<File>): Promise<{ project: StudioProject; skipped: string[] }> {
  const items = Array.from(list).map((f) => ({ file: f, path: ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, "/") }));
  if (!items.length) throw new Error("The folder is empty.");
  const firstSeg = (p: string) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : null);
  const top = firstSeg(items[0].path);
  const strip = top !== null && items.every((i) => firstSeg(i.path) === top);
  const skipped: string[] = [];
  const files: StudioProject["files"] = {};
  let manifest: object | null = null;
  for (const { file, path } of items) {
    const rel = normalizeProjectPath(strip ? path.slice(top!.length + 1) : path);
    if (!rel || rel.split("/").some((s) => s.startsWith("."))) continue;
    if (rel === "game.json") {
      try {
        const parsed: unknown = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        manifest = parsed as object;
      } catch {
        throw new Error("game.json is not a valid JSON object.");
      }
      continue;
    }
    if (!ALLOWED_EXTENSIONS.includes(extOf(rel))) {
      skipped.push(rel);
      continue;
    }
    if (Object.keys(files).length >= MAX_PROJECT_FILES) {
      skipped.push(rel);
      continue;
    }
    files[rel] = isTextPath(rel) ? await file.text() : await file.arrayBuffer();
  }
  if (!manifest) throw new Error("No game.json found at the top of the folder.");
  return { project: { manifest, files }, skipped };
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
