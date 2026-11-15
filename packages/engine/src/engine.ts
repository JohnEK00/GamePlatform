/** The Engine instance handed to games, and boot(). */
import { parseActions, type ControlAction } from './actions';
import { Assets } from './assets';
import { AudioManager, Sound } from './audio';
import { Camera } from './camera';
import { FrameCapture, normalizeMaxSize, type ScreenshotOptions } from './capture';
import { activity, debugLines, FrameMeter, type DebugStats } from './debug';
import { BundleFiles, deriveStorageKey, type FileMap } from './files';
import { computeLetterbox, GamepadButtons, Input } from './input';
import { FixedTimestep } from './loop';
import {
  circleRectOverlap, circlesOverlap, Color, MathUtil, Random, Rect, Vec2, type ColorLike,
} from './math';
import { showErrorOverlay } from './overlay';
import { ParticleEmitter } from './particles';
import { Body, Physics } from './physics';
import { Platform, Storage, defaultPoster, isRequestId, storageHandshake } from './platform';
import { Renderer } from './renderer';
import { SceneManager, type Scene, type SceneLike } from './scenes';
import { Animation, SpriteSheet, Texture } from './texture';
import { Tilemap } from './tilemap';
import { Easing, Timers, Tween, TweenManager } from './tween';

export const VERSION = '1.0.0';

/** What a game bundle default-exports (an object, or a class instantiated with `new`). */
export interface Game {
  load?(engine: Engine): void | Promise<void>;
  update?(engine: Engine, dt: number): void;
  render?(engine: Engine, alpha: number): void;
}
export type GameLike = Game | (new (engine: Engine) => Game);

export interface BootOptions {
  /** Logical resolution (game units). */
  width: number;
  height: number;
  /** URL the bundle's files are served from; asset paths resolve against it. */
  baseUrl?: string;
  /**
   * How the canvas is sized: "window" (default) letterboxes to the viewport, "parent" fits the
   * canvas' parent element, "none" leaves CSS sizing to you (backing store still follows it).
   */
  fit?: 'window' | 'parent' | 'none';
  /** Cap on devicePixelRatio used for the backing store (default 3). */
  maxPixelRatio?: number;
  /** Default texture filtering (default false = crisp pixel art). */
  smooth?: boolean;
  /** Frame clear color (default black). */
  background?: ColorLike;
  /**
   * Namespace for engine.storage. Default: baseUrl; for studio boots (baseUrl "about:blank" or
   * `files` given) derived from game.json id/title, else a hash of the file paths.
   */
  storageKey?: string;
  /** Show the built-in "Paused" overlay when the host pauses the game (default true). */
  pauseOverlay?: boolean;
  /**
   * In-memory bundle files keyed by bundle-relative path (studio mode). All asset loaders resolve
   * paths here first (Blob / ArrayBuffer / string; MIME by extension) and fall back to baseUrl.
   */
  files?: FileMap;
  /** Start with the debug overlay visible (default false; F3 toggles it). */
  debug?: boolean;
  /**
   * F009: the game.json `actions` list. Parsed leniently (invalid entries are dropped with a
   * `[pixelforge] actions:` warning); read them with `input.actionDown/actionPressed/...`.
   */
  actions?: unknown;
}

/** Lenient parse of the `actions` boot option; each dropped entry/key is a `[pixelforge] actions:` warning. */
export function bootActions(raw: unknown): ControlAction[] {
  const { actions, warnings } = parseActions(raw);
  for (const m of warnings) console.warn('[pixelforge] actions:', m);
  return actions;
}

/** Most action ids a `webgame:controls` overrides object may carry. */
export const MAX_OVERRIDE_KEYS = 32;

/** `webgame:controls` payload check: a plain object with at most 32 own keys. */
export function isOverridesObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false; // not a plain object (any realm)
  return Reflect.ownKeys(v).length <= MAX_OVERRIDE_KEYS;
}

type PauseReason = 'host' | 'hidden' | 'user';
type State = 'loading' | 'running' | 'error' | 'destroyed';

const reported = new WeakSet<object>();
let globalHandlersFor: Engine | null = null;

function errText(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message || String(e), stack: e.stack };
  if (typeof e === 'string') return { message: e };
  try {
    return { message: JSON.stringify(e) };
  } catch {
    return { message: String(e) };
  }
}

export class Engine {
  // --- utilities exposed to bundles (no imports needed) ---
  readonly Vec2 = Vec2;
  readonly Rect = Rect;
  readonly Color = Color;
  readonly Random = Random;
  readonly Tilemap = Tilemap;
  readonly Physics = Physics;
  readonly Body = Body;
  readonly ParticleEmitter = ParticleEmitter;
  readonly Tween = Tween;
  readonly Easing = Easing;
  readonly SpriteSheet = SpriteSheet;
  readonly Animation = Animation;
  readonly Texture = Texture;
  readonly Sound = Sound;
  readonly Camera = Camera;
  readonly GamepadButtons = GamepadButtons;
  readonly math = { ...MathUtil, circlesOverlap, circleRectOverlap };
  readonly version = VERSION;

  // --- core systems ---
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly baseUrl: string;
  readonly renderer: Renderer;
  readonly assets: Assets;
  readonly input: Input;
  readonly audio: AudioManager;
  readonly scenes: SceneManager<Engine>;
  readonly storage: Storage;
  readonly platform: Platform;
  readonly tweens = new TweenManager();
  /** Shared seedable RNG. */
  readonly random = new Random();
  /** The game object the bundle exported (instantiated if it was a class). */
  game: Game | null = null;

  /** Simulated seconds since start (advances only while running). */
  time = 0;
  /** Number of fixed update steps run so far. */
  frame = 0;
  /** Fixed update step (seconds). */
  readonly dt = 1 / 60;
  /** Measured rendering frames per second. */
  fps = 0;
  /** Device pixels per game unit (for HiDPI-aware drawing decisions). */
  pixelRatio = 1;
  /** Show the debug overlay (FPS, frame ms, draw calls, sprites, tweens/particles/bodies). F3 toggles it. */
  debug = false;
  /** Numbers shown by the debug overlay (updated every rendered frame, also while hidden). */
  readonly debugStats: DebugStats = { fps: 0, frameMs: 0, workMs: 0, drawCalls: 0, sprites: 0, tweens: 0, particles: 0, bodies: 0 };
  /** In-memory bundle files (boot option `files`). */
  readonly files: BundleFiles;

  private readonly opts: BootOptions;
  private readonly stepper = new FixedTimestep(1 / 60);
  private readonly timers = new Timers();
  private readonly pauseReasons = new Set<PauseReason>();
  private state: State = 'loading';
  private raf = 0;
  private last = -1;
  private readonly cleanup: (() => void)[] = [];
  private lastSize = '';
  private readonly meter = new FrameMeter();
  private readonly capturer: FrameCapture;

  constructor(canvas: HTMLCanvasElement, opts: BootOptions) {
    if (!canvas || typeof (canvas as HTMLCanvasElement).getContext !== 'function') throw new Error('boot(): a <canvas> element is required');
    const w = Math.round(Number(opts?.width));
    const h = Math.round(Number(opts?.height));
    if (!(w >= 1 && h >= 1)) throw new Error('boot(): width and height must be positive numbers');
    this.opts = opts;
    this.canvas = canvas;
    this.width = w;
    this.height = h;
    this.baseUrl = opts.baseUrl ?? (typeof location !== 'undefined' ? new URL('./', location.href).href : '');
    this.platform = new Platform();
    this.renderer = new Renderer(canvas, w, h); // throws if WebGL2 is missing
    this.renderer.defaultSmooth = !!opts.smooth;
    if (opts.background !== undefined) this.renderer.background = opts.background;
    this.audio = new AudioManager();
    this.files = new BundleFiles(opts.files, this.baseUrl);
    this.assets = new Assets(this.baseUrl, this.renderer, this.audio, this.files);
    this.debug = !!opts.debug;
    this.input = new Input(canvas, w, h);
    this.input.setActions(bootActions(opts.actions));
    this.scenes = new SceneManager<Engine>(this);
    this.storage = new Storage(deriveStorageKey(this.baseUrl, opts.files, opts.storageKey),this.platform);
    this.capturer = new FrameCapture(w, h);
    this.platform.setCapture(() =>
      this.state === 'running' ? this.capturer.capture('share') : Promise.resolve({ error: 'unavailable' as const }),
    );
  }

  // -------------------------------------------------------------------------
  // Public helpers
  // -------------------------------------------------------------------------

  /** Shortcut for renderer.camera. */
  get camera(): Camera {
    return this.renderer.camera;
  }
  /** True while paused for any reason. */
  get paused(): boolean {
    return this.pauseReasons.size > 0;
  }
  /** Pause the simulation (update stops; render continues). */
  pause(): void {
    this.setPaused('user', true);
  }
  resume(): void {
    this.setPaused('user', false);
  }
  /** Run `fn` after `seconds` of game time. */
  after(seconds: number, fn: () => void): { cancel(): void } {
    return this.timers.after(seconds, fn);
  }
  /** Run `fn` every `seconds` of game time. */
  every(seconds: number, fn: () => void): { cancel(): void } {
    return this.timers.every(seconds, fn);
  }
  /**
   * Capture the next rendered frame as a PNG for the game's own use (nothing is posted). Resolves
   * null when not running, busy, after 2000 ms without a frame, on failure, or over 8 MiB.
   * `maxSize` (longest side) is rounded and clamped to 64–4096, default 1920.
   */
  captureFrame(opts: ScreenshotOptions = {}): Promise<Blob | null> {
    if (this.state !== 'running') return Promise.resolve(null);
    return this.capturer.request('game', { maxSize: normalizeMaxSize(opts?.maxSize) });
  }

  /** Convenience: push/replace scenes. */
  setScene(scene: SceneLike<Engine>): Promise<Scene<Engine>> {
    return this.scenes.size ? this.scenes.replace(scene) : this.scenes.push(scene);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Engine-internal: attach listeners, run game.load(), start the loop. */
  async start(gameLike: GameLike, saved?: Promise<Record<string, unknown> | null>): Promise<void> {
    this.attach();
    this.raf = requestAnimationFrame(this.tick);
    try {
      // Storage handshake: seed storage with the parent's saved data before game.load().
      const data = await (saved ?? Promise.resolve(null)).catch(() => null);
      if (this.state !== 'loading') return;
      if (data) this.storage.hydrate(data);
      const g = typeof gameLike === 'function' ? new (gameLike as new (e: Engine) => Game)(this) : gameLike;
      if (!g || typeof g !== 'object') throw new Error('The game module must default-export a game object or class');
      this.game = g;
      await g.load?.(this);
      if (this.state !== 'loading') return;
      this.state = 'running';
      this.last = -1;
      this.platform.ready();
    } catch (e) {
      this.fail(e, 'The game failed to load');
      throw e;
    }
  }

  private attach(): void {
    const on = (t: EventTarget, type: string, fn: EventListener): void => {
      t.addEventListener(type, fn);
      this.cleanup.push(() => t.removeEventListener(type, fn));
    };
    this.input.attach();
    this.cleanup.push(() => this.input.detach());
    this.cleanup.push(this.audio.attachUnlock(window));

    on(window, 'message', ((e: MessageEvent) => this.onMessage(e)) as EventListener);
    on(window, 'pagehide', () => this.storage.flush());
    on(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code !== 'F3' || e.repeat) return;
      e.preventDefault(); // browsers bind F3 to find-next
      this.debug = !this.debug;
    }) as EventListener);
    on(document, 'visibilitychange', () => this.setPaused('hidden', document.visibilityState === 'hidden'));
    if (document.visibilityState === 'hidden') this.setPaused('hidden', true);

    on(this.canvas, 'webglcontextlost', ((e: Event) => {
      e.preventDefault();
      this.fail(new Error('The graphics context was lost (GPU reset or too many WebGL pages open).'), 'Graphics context lost');
    }) as EventListener);

    on(window, 'resize', () => this.resize());
    if (this.opts.fit !== 'window' && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.opts.fit === 'parent' && this.canvas.parentElement ? this.canvas.parentElement : this.canvas);
      this.cleanup.push(() => ro.disconnect());
    }
    if (globalHandlersFor === null) {
      globalHandlersFor = this;
      const onErr = (ev: ErrorEvent): void => this.reportGlobal(ev.error ?? ev.message);
      const onRej = (ev: PromiseRejectionEvent): void => this.reportGlobal(ev.reason);
      window.addEventListener('error', onErr);
      window.addEventListener('unhandledrejection', onRej);
      this.cleanup.push(() => {
        window.removeEventListener('error', onErr);
        window.removeEventListener('unhandledrejection', onRej);
        globalHandlersFor = null;
      });
    }
    this.resize();
    try {
      this.canvas.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }

  /** Host → game messages (only from window.parent). */
  private onMessage(e: MessageEvent): void {
    if (e.source !== window.parent) return;
    const d = e.data as { type?: unknown; muted?: unknown; data?: unknown; requestId?: unknown; overrides?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    switch (d.type) {
      case 'webgame:pause':
        this.setPaused('host', true);
        break;
      case 'webgame:resume':
        this.setPaused('host', false);
        break;
      case 'webgame:mute':
        this.audio.muted = d.muted === undefined ? true : !!d.muted;
        break;
      case 'webgame:load':
        this.storage.hydrate(d.data); // later loads merge; non-objects are ignored
        break;
      case 'webgame:leaderboard':
      case 'webgame:score-result':
      case 'webgame:screenshot-result':
        this.platform.handleReply(d);
        break;
      case 'webgame:screenshot-request':
        this.onScreenshotRequest(d.requestId);
        break;
      case 'webgame:controls': // F009: replaces all previous overrides; applied at the next step
        if (isOverridesObject(d.overrides)) this.input.setOverrides(d.overrides);
        break;
    }
  }

  /** Parent asked for a screenshot (`source: "player"`): capture the next frame and reply. */
  private onScreenshotRequest(requestId: unknown): void {
    if (!isRequestId(requestId)) return;
    if (this.state !== 'running') {
      this.platform.screenshotReply(requestId, { error: 'unavailable' });
      return;
    }
    void this.capturer.capture('player').then((r) => this.platform.screenshotReply(requestId, r));
  }

  private reportGlobal(err: unknown): void {
    if (err && typeof err === 'object') {
      if (reported.has(err)) return;
      reported.add(err);
    }
    const { message } = errText(err);
    console.error('[pixelforge] uncaught error:', err);
    this.platform.error(message);
  }

  private setPaused(reason: PauseReason, on: boolean): void {
    const was = this.paused;
    if (on) this.pauseReasons.add(reason);
    else this.pauseReasons.delete(reason);
    if (was !== this.paused) {
      this.audio.setSuspended(this.paused);
      this.input.state.releaseAll();
      this.stepper.reset();
      this.last = -1;
    }
  }

  /** Recompute canvas CSS size (letterboxed) and HiDPI backing store. */
  resize(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio ?? 3);
    const fit = this.opts.fit ?? 'window';
    let cssW: number;
    let cssH: number;
    if (fit === 'none') {
      const r = c.getBoundingClientRect();
      cssW = r.width || this.width;
      cssH = r.height || this.height;
    } else {
      const parent = c.parentElement;
      const availW = fit === 'parent' && parent ? parent.clientWidth : window.innerWidth;
      const availH = fit === 'parent' && parent ? parent.clientHeight : window.innerHeight;
      const lb = computeLetterbox(Math.max(1, availW), Math.max(1, availH), this.width, this.height);
      cssW = lb.width;
      cssH = lb.height;
      const s = c.style;
      s.display = 'block';
      s.width = `${cssW}px`;
      s.height = `${cssH}px`;
      if (fit === 'window') {
        s.position = 'fixed';
        s.left = `${lb.x}px`;
        s.top = `${lb.y}px`;
        s.margin = '0';
      } else {
        s.margin = `${lb.y}px auto 0`;
      }
    }
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    const key = `${pw}x${ph}`;
    if (key !== this.lastSize) {
      this.lastSize = key;
      c.width = pw;
      c.height = ph;
      this.renderer.resize(pw, ph);
    }
    this.pixelRatio = pw / this.width;
  }

  private readonly tick = (now: number): void => {
    if (this.state === 'error' || this.state === 'destroyed') return;
    this.raf = requestAnimationFrame(this.tick);
    const frameDt = this.last < 0 ? 0 : (now - this.last) / 1000;
    this.last = now;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.1;
    this.meter.sample(frameDt);
    if ((window.devicePixelRatio || 1) * 1000 + window.innerWidth + window.innerHeight * 1e5 !== this.sizeProbe) {
      this.sizeProbe = (window.devicePixelRatio || 1) * 1000 + window.innerWidth + window.innerHeight * 1e5;
      this.resize();
    }
    try {
      if (this.state === 'loading') {
        this.renderLoading();
        return;
      }
      const t0 = performance.now();
      const alpha = this.paused ? 1 : this.stepper.advance(frameDt, this.step);
      this.render(alpha, t0);
    } catch (e) {
      this.fail(e, 'The game crashed');
    }
  };
  private sizeProbe = 0;

  private readonly step = (dt: number): void => {
    if (this.state !== 'running' || this.paused) return;
    this.input.beginStep();
    this.game?.update?.(this, dt);
    this.scenes.update(dt);
    this.tweens.update(dt);
    this.timers.update(dt);
    this.renderer.camera.update(dt);
    this.time += dt;
    this.frame++;
    this.input.endStep();
  };

  private render(alpha: number, t0 = performance.now()): void {
    const r = this.renderer;
    r.beginFrame();
    this.game?.render?.(this, alpha);
    this.scenes.render(alpha);
    r.flush();
    // Capture point (F005): the game's frame is complete; overlays below are not captured.
    if (this.state === 'running' && this.capturer.queued) this.capturer.grab(this.canvas, r.defaultSmooth, r.gl);
    const s = this.debugStats;
    const act = activity.collect();
    s.fps = this.meter.fps;
    s.frameMs = this.meter.frameMs;
    s.drawCalls = r.counter.drawCalls;
    s.sprites = r.counter.sprites;
    s.tweens = this.tweens.count;
    s.particles = act.particles;
    s.bodies = act.bodies;
    s.workMs = performance.now() - t0;
    if (this.debug) this.drawDebug();
    if (this.pauseReasons.has('host') && this.opts.pauseOverlay !== false) {
      r.ui(() => {
        r.drawRect(0, 0, this.width, this.height, [0, 0, 0, 0.55]);
        const s = Math.max(16, Math.min(this.width, this.height) / 10);
        r.drawText('PAUSED', this.width / 2, this.height / 2, { size: s, align: 'center', baseline: 'middle', color: '#fff' });
      });
    }
    r.endFrame();
  }

  /** The debug overlay, drawn in screen space with the engine's own text rendering. */
  private drawDebug(): void {
    const r = this.renderer;
    const lines = debugLines(this.debugStats);
    const size = Math.max(9, Math.min(16, Math.round(Math.min(this.width, this.height) / 34)));
    const lh = Math.round(size * 1.3);
    const pad = Math.round(size * 0.5);
    let w = 0;
    for (const l of lines) w = Math.max(w, r.measureText(l, { size, font: 'mono' }).width);
    r.setBlend('normal');
    r.ui(() => {
      r.drawRect(4, 4, w + pad * 2, (lines.length - 1) * lh + size + pad * 2, [0, 0, 0, 0.72]);
      const fps = this.debugStats.fps;
      const fpsColor = fps >= 55 ? '#7dff9a' : fps >= 30 ? '#ffd166' : '#ff6b6b';
      lines.forEach((l, i) => r.drawText(l, 4 + pad, 4 + pad + i * lh, { size, font: 'mono', color: i === 0 ? fpsColor : '#e8ecf4' }));
    });
  }

  private renderLoading(): void {
    const r = this.renderer;
    r.beginFrame();
    r.clear('#0b0e18');
    const W = this.width;
    const H = this.height;
    const bw = Math.min(W * 0.5, 320);
    const bh = Math.max(6, H * 0.012);
    const x = (W - bw) / 2;
    const y = H / 2;
    const p = this.assets.progress;
    r.ui(() => {
      r.drawText('PIXELFORGE', W / 2, y - bh * 3, { size: Math.max(12, H / 28), align: 'center', baseline: 'bottom', color: '#8ea2ff', letterSpacing: 2 });
      r.drawRect(x, y, bw, bh, '#1e2540');
      r.drawRect(x, y, bw * p, bh, '#4c6fff');
    });
    r.endFrame();
  }

  /** Stop the game, post the error to the host and show the overlay. */
  fail(err: unknown, title = 'The game crashed'): void {
    if (this.state === 'error' || this.state === 'destroyed') return;
    this.state = 'error';
    cancelAnimationFrame(this.raf);
    this.capturer?.cancel('failed');
    if (err && typeof err === 'object') reported.add(err);
    const { message, stack } = errText(err);
    console.error('[pixelforge]', err);
    this.platform.error(message);
    try {
      this.audio.stopAll();
      this.audio.setSuspended(true);
    } catch {
      /* ignore */
    }
    showErrorOverlay(title, message, stack);
  }

  /** Stop the loop and detach all listeners. */
  destroy(): void {
    this.state = 'destroyed';
    this.storage.flush();
    this.capturer.close();
    this.platform.cancelPending();
    cancelAnimationFrame(this.raf);
    for (const f of this.cleanup.splice(0)) f();
    this.audio.stopAll();
    this.renderer.destroy();
    this.files.dispose();
  }
}

/**
 * Boot a game on a canvas. Resolves with the Engine once `game.load()` finished and the loop runs.
 * On failure (no WebGL2, load error) an overlay is shown, `webgame:error` is posted and the promise rejects.
 */
export async function boot(canvas: HTMLCanvasElement, game: GameLike, opts: BootOptions): Promise<Engine> {
  // Storage handshake first: post webgame:hello and wait (<=500ms) for webgame:load before game.load().
  const saved = storageHandshake(typeof window !== 'undefined' ? window : null, defaultPoster());
  let engine: Engine;
  try {
    engine = new Engine(canvas, opts);
  } catch (e) {
    const { message } = errText(e);
    const noGL = /WebGL2/i.test(message);
    if (e && typeof e === 'object') reported.add(e);
    new Platform().error(message);
    console.error('[pixelforge]', e);
    showErrorOverlay(
      noGL ? 'WebGL2 not available' : 'Could not start the game',
      noGL
        ? 'This game needs WebGL2, which your browser or device does not support (or it is disabled). Try an up-to-date Chrome, Firefox, Edge or Safari, and enable hardware acceleration.'
        : message,
    );
    throw e;
  }
  await engine.start(game, saved);
  return engine;
}
