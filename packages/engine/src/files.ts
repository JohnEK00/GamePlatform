/**
 * In-memory bundle files (`boot(..., { files })`): used by the studio player, where the bundle is not
 * served over HTTP. Paths are bundle-relative ("assets/ship.png"); values are Blobs, ArrayBuffers
 * (or typed-array views) or strings (text content, or a `data:` URL).
 */

export type FileData = Blob | ArrayBuffer | ArrayBufferView | string;
export type FileMap = Record<string, FileData>;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', json: 'application/json', txt: 'text/plain',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', woff2: 'font/woff2', ttf: 'font/ttf', html: 'text/html',
};

/** MIME type for a path, by extension (default application/octet-stream). */
export function mimeType(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path.split(/[?#]/)[0] ?? '');
  return (m ? MIME[m[1]!.toLowerCase()] : undefined) ?? 'application/octet-stream';
}

/**
 * Normalize a bundle-relative path: strips query/hash, leading "./" and "/", backslashes, resolves
 * "." / ".." segments. Returns null when it escapes the bundle root.
 */
export function normalizePath(path: string): string | null {
  let p = String(path).split(/[?#]/)[0]!.replace(/\\/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function decodeDataUrl(s: string): Blob | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(s);
  if (!m) return null;
  const type = m[1] || 'text/plain';
  if (m[2]) {
    const bin = atob(m[3]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(m[3]!)], { type });
}

/** 32-bit FNV-1a hash of a string, as 8 hex chars. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function textOf(v: FileData | undefined): string | null {
  if (typeof v === 'string') {
    if (!v.startsWith('data:')) return v;
    const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(v);
    if (!m) return null;
    try {
      return m[1] ? atob(m[2]!) : decodeURIComponent(m[2]!);
    } catch {
      return null;
    }
  }
  try {
    if (v instanceof ArrayBuffer) return new TextDecoder().decode(v);
    if (v && ArrayBuffer.isView(v)) return new TextDecoder().decode(v);
  } catch {
    /* ignore */
  }
  return null; // Blob: not readable synchronously
}

/**
 * Namespace for `engine.storage`. An explicit `storageKey` always wins. Normal boots use `baseUrl`.
 * Studio-style boots (`baseUrl` "about:blank"/empty, or in-memory `files` given) derive a stable key
 * from the bundle identity: the `id` (else `title`) of `game.json` when it is readable synchronously,
 * else a hash of the sorted file paths. Result: `studio:id:<id>` or `studio:paths:<hash>`.
 */
export function deriveStorageKey(baseUrl: string, files?: FileMap | null, storageKey?: string): string {
  if (storageKey) return storageKey;
  const hasFiles = !!files && typeof files === 'object' && Object.keys(files).length > 0;
  const blank = !baseUrl || baseUrl === 'about:blank';
  if (!hasFiles && !blank) return baseUrl;
  const norm = new Map<string, FileData>();
  if (hasFiles) {
    for (const [k, v] of Object.entries(files!)) {
      const n = normalizePath(k);
      if (n && v != null) norm.set(n, v);
    }
  }
  const text = textOf(norm.get('game.json'));
  if (text !== null) {
    try {
      const m = JSON.parse(text) as { id?: unknown; title?: unknown };
      const ident = typeof m.id === 'string' && m.id ? m.id : typeof m.title === 'string' && m.title ? m.title : '';
      if (ident) return `studio:id:${fnv1a(ident)}`;
    } catch {
      /* fall through */
    }
  }
  if (norm.size === 0) return baseUrl || 'about:blank';
  return `studio:paths:${fnv1a([...norm.keys()].sort().join('\n'))}`;
}

export class BundleFiles {
  private readonly map = new Map<string, FileData>();
  private readonly blobs = new Map<string, Blob>();
  private readonly urls = new Map<string, string>();

  constructor(
    files?: FileMap | null,
    /** The bundle's baseUrl: absolute URLs below it are mapped back to bundle paths. */
    private readonly baseUrl = '',
  ) {
    if (files && typeof files === 'object') {
      for (const [k, v] of Object.entries(files)) {
        const n = normalizePath(k);
        if (n && v != null) this.map.set(n, v);
      }
    }
  }

  /** Number of files. */
  get size(): number {
    return this.map.size;
  }

  /** All (normalized) paths. */
  paths(): string[] {
    return [...this.map.keys()];
  }

  /** Map a loader path (relative, or absolute under baseUrl) to a key in the map, or null. */
  resolve(path: string): string | null {
    if (this.map.size === 0) return null;
    let p = String(path);
    if (this.baseUrl && /^[a-z][a-z0-9+.-]*:/i.test(this.baseUrl) && p.startsWith(this.baseUrl)) p = p.slice(this.baseUrl.length);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null; // other absolute URL (http:, data:, blob:)
    const n = normalizePath(p);
    return n !== null && this.map.has(n) ? n : null;
  }

  has(path: string): boolean {
    return this.resolve(path) !== null;
  }

  /** The file as a Blob with the MIME type of its extension (cached), or null. */
  blob(path: string): Blob | null {
    const key = this.resolve(path);
    if (key === null) return null;
    let b = this.blobs.get(key);
    if (b) return b;
    const v = this.map.get(key)!;
    const type = mimeType(key);
    if (typeof v === 'string') b = (v.startsWith('data:') ? decodeDataUrl(v) : null) ?? new Blob([v], { type });
    else if (typeof Blob !== 'undefined' && v instanceof Blob) b = v.type ? v : new Blob([v], { type });
    else if (v instanceof ArrayBuffer) b = new Blob([v], { type });
    else if (ArrayBuffer.isView(v)) b = new Blob([new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()], { type });
    else return null;
    this.blobs.set(key, b);
    return b;
  }

  /** A fetch-like Response for the file (status 200), or null if it isn't in the map. */
  response(path: string): Response | null {
    const b = this.blob(path);
    if (!b) return null;
    return new Response(b, { status: 200, headers: { 'Content-Type': b.type || mimeType(path) } });
  }

  /** A `blob:` object URL for the file (created once, revoked by `dispose()`), or null. */
  objectUrl(path: string): string | null {
    const key = this.resolve(path);
    if (key === null) return null;
    const hit = this.urls.get(key);
    if (hit) return hit;
    const b = this.blob(key);
    if (!b || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(b);
    this.urls.set(key, url);
    return url;
  }

  /** Revoke all object URLs created by `objectUrl()`. */
  dispose(): void {
    for (const u of this.urls.values()) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    this.urls.clear();
    this.blobs.clear();
  }
}
