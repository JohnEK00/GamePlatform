/** Bridge to the hosting page (parent window) + per-game storage. */

export type PlatformMessage =
  | { type: 'webgame:ready' }
  | { type: 'webgame:score'; score: number }
  | { type: 'webgame:error'; message: string }
  | { type: 'webgame:save'; data: Record<string, unknown> }
  | { type: 'webgame:hello' }
  | { type: 'webgame:fullscreen' }
  | { type: 'webgame:achievement'; id: string };

export type Poster = (msg: PlatformMessage) => void;

/** Post a message to `window.parent` (no-op outside a browser). */
export function defaultPoster(): Poster {
  return (msg) => {
    try {
      const target = typeof window !== 'undefined' ? window.parent : null;
      target?.postMessage(msg, '*');
    } catch {
      /* ignore: cross-origin or detached */
    }
  };
}

/** Achievement ids must match this (docs/GAME_FORMAT.md). */
export const ACHIEVEMENT_ID_RE = /^[a-z0-9_-]{1,32}$/;

export class Platform {
  private readySent = false;
  private readonly unlocked = new Set<string>();
  /** Last score submitted. */
  lastScore: number | null = null;

  constructor(private readonly post: Poster = defaultPoster()) {}

  /** Report a score to the platform (e.g. on game over). Non-finite values are ignored. */
  submitScore(score: number): void {
    const n = Number(score);
    if (!Number.isFinite(n)) return;
    this.lastScore = n;
    this.post({ type: 'webgame:score', score: n });
  }

  /**
   * Unlock an achievement declared in game.json (`achievements[].id`). Posts
   * `{ type: 'webgame:achievement', id }` once per session; repeated calls are ignored.
   * Returns true if the message was posted, false for duplicates or invalid ids (warned).
   */
  unlockAchievement(id: string): boolean {
    if (typeof id !== 'string' || !ACHIEVEMENT_ID_RE.test(id)) {
      console.warn(`[pixelforge] unlockAchievement: invalid id ${JSON.stringify(id)} (expected ${ACHIEVEMENT_ID_RE})`);
      return false;
    }
    if (this.unlocked.has(id)) return false;
    this.unlocked.add(id);
    this.post({ type: 'webgame:achievement', id });
    return true;
  }

  /** Whether `unlockAchievement(id)` was already called this session. */
  isUnlocked(id: string): boolean {
    return this.unlocked.has(id);
  }

  /** Ids unlocked this session, in order. */
  get achievements(): string[] {
    return [...this.unlocked];
  }

  /** Tell the platform the game finished loading (the engine calls this after load()). */
  ready(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.post({ type: 'webgame:ready' });
  }

  /** Report an error to the platform. */
  error(message: string): void {
    this.post({ type: 'webgame:error', message: String(message).slice(0, 2000) });
  }

  /** Ask the host page to toggle fullscreen for the player (extension; host may ignore it). */
  requestFullscreen(): void {
    this.post({ type: 'webgame:fullscreen' });
  }

  /** Engine-internal: start of the storage handshake (the parent answers with `webgame:load`). */
  hello(): void {
    this.post({ type: 'webgame:hello' });
  }

  /** Engine-internal: used by Storage; `data` is the full storage object. */
  save(data: Record<string, unknown>): void {
    this.post({ type: 'webgame:save', data });
  }
}

/** Max size the parent persists (GAME_FORMAT.md); larger saves are still posted but warned about. */
export const SAVE_LIMIT_BYTES = 256 * 1024;

/**
 * Per-game key/value storage. In the sandboxed player there is no persistent storage, so values
 * live in memory and the full object is mirrored to the parent via `webgame:save` (debounced).
 * The parent seeds it at boot via the `webgame:hello` / `webgame:load` handshake. When run outside
 * a sandbox with localStorage available, localStorage is used as well.
 */
export class Storage {
  private readonly mem = new Map<string, string>();
  private readonly ls: globalThis.Storage | null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly namespace: string,
    private readonly platform: Platform | null,
    /** Debounce for `webgame:save` in ms (0 = post synchronously). */
    private readonly saveDelay = 250,
  ) {
    let ls: globalThis.Storage | null = null;
    try {
      ls = typeof localStorage !== 'undefined' ? localStorage : null;
      ls?.getItem('__pf_probe');
    } catch {
      ls = null;
    }
    this.ls = ls;
    if (ls) {
      // Pull existing namespaced keys into memory so `snapshot()` is the full object.
      try {
        const prefix = this.k('');
        for (let i = 0; i < ls.length; i++) {
          const name = ls.key(i);
          if (name && name.startsWith(prefix)) {
            const raw = ls.getItem(name);
            if (raw !== null) this.mem.set(name.slice(prefix.length), raw);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private k(key: string): string {
    return `pixelforge:${this.namespace}:${key}`;
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    const raw = this.mem.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    if (value === undefined) return this.remove(key);
    const raw = JSON.stringify(value);
    if (raw === undefined) return this.remove(key); // functions, symbols
    this.mem.set(key, raw);
    try {
      this.ls?.setItem(this.k(key), raw);
    } catch {
      /* quota / sandbox */
    }
    this.scheduleSave();
  }

  remove(key: string): void {
    this.mem.delete(key);
    try {
      this.ls?.removeItem(this.k(key));
    } catch {
      /* ignore */
    }
    this.scheduleSave();
  }

  /** The full storage object (what `webgame:save` carries). */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of this.mem) {
      try {
        out[k] = JSON.parse(raw);
      } catch {
        /* skip corrupt entry */
      }
    }
    return out;
  }

  /** Post any pending `webgame:save` now (the engine calls this on destroy / pagehide). */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.postSave();
  }

  private scheduleSave(): void {
    if (!this.platform) return;
    if (this.saveDelay <= 0) return this.postSave();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.postSave();
    }, this.saveDelay);
  }

  private postSave(): void {
    const data = this.snapshot();
    try {
      if (JSON.stringify(data).length > SAVE_LIMIT_BYTES) console.warn(`[pixelforge] storage exceeds ${SAVE_LIMIT_BYTES} bytes; the host may not persist it`);
    } catch {
      /* ignore */
    }
    this.platform?.save(data);
  }

  /** Engine-internal: merge values (e.g. from a parent `webgame:load` message) without echoing them back. */
  hydrate(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      let raw: string | undefined;
      try {
        raw = JSON.stringify(v);
      } catch {
        continue;
      }
      if (raw === undefined) continue;
      this.mem.set(k, raw);
      try {
        this.ls?.setItem(this.k(k), raw);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The bits of `window` the handshake needs (mockable in tests). */
export interface HandshakeWindow {
  readonly parent: unknown;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

/** Default time the engine waits for the parent's `webgame:load` reply. */
export const HANDSHAKE_TIMEOUT_MS = 500;

/**
 * Storage handshake: post `webgame:hello` to the parent and resolve with the `data` of the first
 * `webgame:load` reply from `win.parent` (null if absent/not an object), or null after `timeoutMs`.
 * Resolves null immediately (without posting) when there is no parent (`win.parent === win`).
 */
export function storageHandshake(
  win: HandshakeWindow | null,
  post: (msg: PlatformMessage) => void,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  if (!win || !win.parent || win.parent === win) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Record<string, unknown> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeEventListener('message', onMsg);
      resolve(v);
    };
    const onMsg = (e: MessageEvent): void => {
      if (e.source !== win.parent) return;
      const d = e.data as { type?: unknown; data?: unknown } | null;
      if (!d || typeof d !== 'object' || d.type !== 'webgame:load') return;
      const data = d.data;
      finish(data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    win.addEventListener('message', onMsg);
    try {
      post({ type: 'webgame:hello' });
    } catch {
      /* ignore */
    }
  });
}
