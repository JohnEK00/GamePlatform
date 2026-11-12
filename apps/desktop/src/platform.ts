/** Native integrations (Tauri) with browser fallbacks so `npm run dev` works in a plain browser. */
import { invoke, isTauri as tauriDetected } from "@tauri-apps/api/core";

export const MAX_PICK_BYTES = 60 * 1024 * 1024;

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
