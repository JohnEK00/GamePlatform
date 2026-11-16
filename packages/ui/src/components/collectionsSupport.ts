import { useCallback, useSyncExternalStore } from "react";
import { isApiError, type ApiClient } from "../api/client";
import { useApi } from "../context/config";

/**
 * F008: servers without collections answer the new endpoints with the generic API 404 ("No such API endpoint"), or a
 * 404/405 without an error body. A real "not found" from F008 names the thing ("Collection not found", "Game not
 * found", "User not found").
 */
export function isCollectionsUnsupportedError(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.status === 405 || e.status === 501) return true;
  if (e.status !== 404) return false;
  return !/\b(collection|game|user|player) not found\b/i.test(e.message);
}

// Per ApiClient (one per server): once a request proves the server has no collections, the UI hides them.
const unsupported = new WeakSet<object>();
const listeners = new Set<() => void>();

export function markCollectionsUnsupported(api: ApiClient): void {
  if (unsupported.has(api)) return;
  unsupported.add(api);
  for (const l of Array.from(listeners)) l();
}

/** Marks the server unsupported when `e` shows it; returns whether it did. */
export function noteCollectionsError(api: ApiClient, e: unknown): boolean {
  if (!isCollectionsUnsupportedError(e)) return false;
  markCollectionsUnsupported(api);
  return true;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** False once this server is known to lack the F008 endpoints (collection UI is hidden then). */
export function useCollectionsSupported(): boolean {
  const api = useApi();
  const get = useCallback(() => !unsupported.has(api), [api]);
  return useSyncExternalStore(subscribe, get, get);
}
