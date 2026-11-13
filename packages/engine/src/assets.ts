/** Asset loading: in-memory bundle files first (boot option `files`), then relative to the bundle's baseUrl. */
import type { AudioManager, Sound } from './audio';
import type { Renderer, TextureOptions } from './renderer';
import { BundleFiles } from './files';
import { SpriteSheet, Texture } from './texture';

export class Assets {
  /** Number of loads started / finished (for loading screens). */
  total = 0;
  loaded = 0;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    readonly baseUrl: string,
    private readonly renderer: Renderer,
    private readonly audio: AudioManager,
    /** In-memory bundle files (boot option `files`); empty when the bundle is served over HTTP. */
    readonly files: BundleFiles = new BundleFiles(null, baseUrl),
  ) {}

  /** 0..1 progress of all loads started so far. */
  get progress(): number {
    return this.total === 0 ? 1 : this.loaded / this.total;
  }

  /**
   * URL of a bundle-relative path: a `blob:` object URL for in-memory files (revoked on destroy),
   * otherwise resolved against baseUrl.
   */
  url(path: string): string {
    const mem = this.files.objectUrl(path);
    if (mem) return mem;
    try {
      return new URL(path, this.baseUrl || (typeof location !== 'undefined' ? location.href : undefined)).href;
    } catch {
      return path;
    }
  }

  private track<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) return hit as Promise<T>;
    this.total++;
    const p = fn().then(
      (v) => {
        this.loaded++;
        return v;
      },
      (e: unknown) => {
        this.loaded++;
        this.cache.delete(key);
        throw e;
      },
    );
    this.cache.set(key, p);
    return p;
  }

  private async fetchOk(path: string): Promise<Response> {
    const mem = this.files.response(path);
    if (mem) return mem;
    const url = this.url(path);
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`Failed to load "${path}": ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`Failed to load "${path}": HTTP ${res.status}`);
    return res;
  }

  private async decodeImage(blob: Blob, path: string): Promise<HTMLImageElement> {
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to decode image "${path}"`));
        img.src = objUrl;
      });
      return img;
    } finally {
      // Revoke after the upload has happened (next tick is enough for texImage2D below).
      setTimeout(() => URL.revokeObjectURL(objUrl), 0);
    }
  }

  /** Load an image (png/jpg/webp/gif/svg) as a Texture. */
  loadTexture(path: string, opts: TextureOptions = {}): Promise<Texture> {
    return this.track(`tex:${path}:${opts.smooth ?? ''}:${opts.atlas ?? ''}`, async () => {
      const res = await this.fetchOk(path);
      const img = await this.decodeImage(await res.blob(), path);
      return this.renderer.createTexture(img, opts);
    });
  }

  /** Load an image and cut it into frameW×frameH frames. */
  async loadSpriteSheet(path: string, frameW: number, frameH: number = frameW, opts: TextureOptions & { spacing?: number; margin?: number } = {}): Promise<SpriteSheet> {
    const tex = await this.loadTexture(path, opts);
    return new SpriteSheet(tex, frameW, frameH, opts.spacing ?? 0, opts.margin ?? 0);
  }

  /** Load and decode a sound (wav/mp3/ogg). Decoding works before the audio unlock. */
  loadSound(path: string): Promise<Sound> {
    return this.track(`snd:${path}`, async () => {
      const res = await this.fetchOk(path);
      try {
        return await this.audio.decode(await res.arrayBuffer());
      } catch (e) {
        throw new Error(`Failed to decode sound "${path}": ${(e as Error)?.message ?? e}`);
      }
    });
  }

  loadJSON<T = unknown>(path: string): Promise<T> {
    return this.track(`json:${path}`, async () => {
      const res = await this.fetchOk(path);
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new Error(`Invalid JSON in "${path}": ${(e as Error).message}`);
      }
    });
  }

  loadText(path: string): Promise<string> {
    return this.track(`text:${path}`, async () => (await this.fetchOk(path)).text());
  }

  /** Load raw bytes. */
  loadBinary(path: string): Promise<ArrayBuffer> {
    return this.track(`bin:${path}`, async () => (await this.fetchOk(path)).arrayBuffer());
  }

  /**
   * Load a font file (woff2/ttf) and register it with the renderer under `name`
   * so it can be used with `drawText(..., { font: name })`.
   */
  loadFont(name: string, path: string, weight = 'normal'): Promise<void> {
    return this.track(`font:${name}:${path}`, async () => {
      const buf = await (await this.fetchOk(path)).arrayBuffer();
      const family = `pf-${name.replace(/[^a-z0-9_-]/gi, '')}`;
      const face = new FontFace(family, buf, { weight });
      await face.load();
      (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      this.renderer.setFont(name, `"${family}"`, weight);
    });
  }

  /** Create a texture by drawing on a 2D canvas (procedural graphics). */
  createTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, opts: TextureOptions = {}): Texture {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(width));
    c.height = Math.max(1, Math.ceil(height));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    draw(ctx, c.width, c.height);
    return this.renderer.createTexture(c, opts);
  }

  /** Upload an existing canvas/image/bitmap as a texture. */
  textureFrom(source: TexImageSource, opts: TextureOptions = {}): Texture {
    return this.renderer.createTexture(source, opts);
  }

  /** Cut an existing texture into a sprite sheet. */
  spriteSheet(texture: Texture, frameW: number, frameH: number = frameW, spacing = 0, margin = 0): SpriteSheet {
    return new SpriteSheet(texture, frameW, frameH, spacing, margin);
  }
}
