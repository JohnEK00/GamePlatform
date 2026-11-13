/** Native integrations (Tauri) with browser fallbacks so `npm run dev` works in a plain browser. */
import { invoke, isTauri as tauriDetected } from "@tauri-apps/api/core";
import type { StudioProject } from "@webgame/ui";

export const MAX_PICK_BYTES = 60 * 1024 * 1024;
/** Mirrors `MAX_SAVE_BYTES` in src-tauri/src/save.rs. */
export const MAX_SAVE_BYTES = 100 * 1024 * 1024;

export function isTauri(): boolean {
  try {
    return tauriDetected();
  } catch {
    return false;
  }
}

const MIME_EXTENSIONS: Record<string, string[]> = {
  "application/zip": ["zip"],
  "application/x-zip-compressed": ["zip"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/*": ["png", "jpg", "jpeg", "gif", "webp"],
};

const EXTENSION_MIME: Record<string, string> = {
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** `.zip,application/zip,image/*` → ["zip", "png", ...] (deduplicated, lowercase). */
export function acceptToExtensions(accept: string): string[] {
  const out = new Set<string>();
  for (const raw of accept.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith(".")) out.add(token.slice(1));
    else for (const ext of MIME_EXTENSIONS[token] ?? []) out.add(ext);
  }
  return [...out];
}

function filterName(exts: string[]): string {
  if (exts.length === 1 && exts[0] === "zip") return "Game bundle (.zip)";
  if (exts.every((e) => EXTENSION_MIME[e]?.startsWith("image/"))) return "Images";
  return "Supported files";
}

interface PickedFile {
  ticket: string;
  name: string;
  size: number;
}

/**
 * Rust opens the native dialog and reads the chosen file (`pick_file`); the webview only gets a one-time
 * ticket and never supplies a filesystem path. `read_picked` exchanges the ticket for the bytes.
 */
async function tauriPickFile(accept: string): Promise<File | null> {
  const exts = acceptToExtensions(accept);
  const picked = await invoke<PickedFile | null>("pick_file", {
    filters: exts.length ? [{ name: filterName(exts), extensions: exts }] : null,
  });
  if (!picked) return null;
  // Raw bytes come back as an ArrayBuffer (tauri::ipc::Response), not a JSON number array.
  const bytes = await invoke<ArrayBuffer>("read_picked", { ticket: picked.ticket });
  const name = picked.name || "file";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return new File([bytes], name, { type: EXTENSION_MIME[ext] ?? "application/octet-stream" });
}

/** Plain `<input type=file>` for when the app runs in a normal browser. */
function browserPickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let done = false;
    const finish = (file: File | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

export async function pickFile(accept: string): Promise<File | null> {
  return isTauri() ? tauriPickFile(accept) : browserPickFile(accept);
}

/** Tauri commands reject with plain strings; the UI's toasts only show `Error` messages. */
function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === "string" && e ? e : "Something went wrong.");
}

interface ProjectIndexEntry {
  path: string;
  size: number;
  /** Present for text files (js/json/txt/css/svg). */
  text?: string;
}

interface ProjectIndex {
  /** Ticket for the binary files; null when there are none to fetch. */
  ticket: string | null;
  folder: string;
  manifest: object;
  files: ProjectIndexEntry[];
  skipped: string[];
  skippedCount: number;
}

/** Binary files fetched in parallel at most. */
const READ_CONCURRENCY = 4;

/**
 * `platform.openLocalProject` (desktop only): Rust shows the folder dialog and reads + validates the folder
 * (`pick_project_folder`, same limits as uploads). Text files arrive inline in the index; each binary file is
 * fetched once as a raw ArrayBuffer with `read_project_file(ticket, path)`.
 */
export async function openLocalProject(): Promise<StudioProject | null> {
  let index: ProjectIndex | null;
  try {
    index = await invoke<ProjectIndex | null>("pick_project_folder");
  } catch (e) {
    throw asError(e);
  }
  if (!index) return null;
  const files: StudioProject["files"] = {};
  const binaries: string[] = [];
  for (const f of index.files) {
    if (typeof f.text === "string") files[f.path] = f.text;
    else if (f.size === 0) files[f.path] = new ArrayBuffer(0);
    else binaries.push(f.path);
  }
  const ticket = index.ticket;
  if (binaries.length && ticket) {
    let next = 0;
    const worker = async () => {
      while (next < binaries.length) {
        const path = binaries[next++];
        files[path] = await invoke<ArrayBuffer>("read_project_file", { ticket, path });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, binaries.length) }, worker));
    } catch (e) {
      invoke("release_project", { ticket }).catch(() => {});
      throw asError(e);
    }
  }
  if (index.skippedCount) {
    console.info(`Opened "${index.folder}": skipped ${index.skippedCount} file(s)`, index.skipped);
  }
  return { manifest: index.manifest, files };
}

/**
 * `platform.saveFile` (desktop only): sends the bytes as a raw IPC body (the name goes in a header) to
 * `save_file`, which shows the native save dialog and writes the file. true = saved, false = cancelled.
 */
export async function saveFile(suggestedName: string, data: Blob): Promise<boolean> {
  if (data.size > MAX_SAVE_BYTES) throw new Error(`The file is too large to save (max ${MAX_SAVE_BYTES / 1024 / 1024} MB).`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  try {
    return await invoke<boolean>("save_file", bytes, { headers: { "x-file-name": encodeURIComponent(suggestedName) } });
  } catch (e) {
    throw asError(e);
  }
}
