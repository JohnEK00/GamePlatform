import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError } from "./api/client";

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [86400 * 30, "month"],
    [86400 * 365, "year"],
  ];
  let label = "";
  for (let i = units.length - 1; i >= 0; i--) {
    const [sec, name] = units[i];
    if (s >= sec) {
      const v = Math.floor(s / sec);
      label = `${v} ${name}${v === 1 ? "" : "s"} ago`;
      break;
    }
  }
  return label;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

/** Parse a comma/space separated tag string into normalised tags. */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function validateTags(tags: string[]): string | null {
  if (tags.length > 8) return "At most 8 tags.";
  const long = tags.find((t) => t.length > 24);
  if (long) return `Tag "${long}" is longer than 24 characters.`;
  return null;
}

/** Stable small hash for deterministic generated art. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type AsyncState<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
};

/** Minimal data-loading hook; reruns when deps change, ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (d) => {
        if (!alive) return;
        setDataState(d);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((u: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof u === "function" ? (u as (p: T | undefined) => T)(prev) : u));
  }, []);
  return { data, error, loading, reload, setData };
}

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title === undefined) return;
    const prev = document.title;
    document.title = title ? `${title} · Pixelforge Arcade` : "Pixelforge Arcade";
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/** Check a File starts with the zip local-file-header magic "PK\x03\x04". */
export async function looksLikeZip(file: Blob): Promise<boolean> {
  try {
    const buf = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
  } catch {
    return true; // can't check — let the server decide
  }
}

/**
 * F001: the single score formatter (leaderboard panel, toasts, in-game views).
 * "number" → locale string; "time" (ms) → m:ss.mmm, or h:mm:ss.mmm from 1h. Negative/non-finite → "—".
 */
export function formatScore(score: number, format: "number" | "time" = "number"): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "—";
  if (format !== "time") return score.toLocaleString();
  if (score < 0) return "—";
  const total = Math.round(score);
  const ms = total % 1000;
  const totalSec = Math.floor(total / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    return `${h}:${pad(totalMin % 60, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
  }
  return `${totalMin}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** F001: "5h 12m" / "3d 4h" / "12m" until `endIso`, or null when unknown/past. */
export function formatTimeUntil(endIso: string | null | undefined, now = Date.now()): string | null {
  if (!endIso) return null;
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return null;
  const left = end - now;
  if (left <= 0) return null;
  const mins = Math.max(1, Math.floor(left / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
