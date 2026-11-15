import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_TIMEOUT_MS, FrameCapture, MAX_SCREENSHOT_BYTES, isIntegerRatio, normalizeMaxSize, screenshotSize,
  type FrameGrabber,
} from '../src/capture';
import { Engine } from '../src/engine';
import { Platform, type PlatformMessage } from '../src/platform';

const png = (n = 16): Blob => new Blob([new Uint8Array(n)], { type: 'image/png' });

/** A grabber that records its calls and resolves with `blob` (or a deferred promise). */
function fakeGrabber(result: () => Promise<Blob> = () => Promise.resolve(png())) {
  const calls: { w: number; h: number; smooth: boolean }[] = [];
  const grab: FrameGrabber = (_src, w, h, smooth) => {
    calls.push({ w, h, smooth });
    return result();
  };
  return { grab, calls };
}

const canvas = (width: number, height: number) => ({ width, height });

describe('screenshotSize', () => {
  it.each([
    [320, 180, undefined, 1280, 720],
    [800, 600, undefined, 800, 600],
    [64, 4096, undefined, 64, 4096], // short side kept at 64 (long side exceeds maxSize)
    [4096, 64, undefined, 4096, 64],
    [4096, 128, undefined, 2048, 64], // 1920×60 would be too small → raised to short side 64
    [2048, 64, 640, 2048, 64],
    [1000, 100, undefined, 1000, 100],
    [1000, 100, 64, 640, 64],
    [64, 64, 64, 64, 64],
    [10, 5000, undefined, 64, 4096], // out-of-contract input still clamped to 64–4096
    [3840, 2160, undefined, 1920, 1080],
    [160, 144, undefined, 1280, 1152],
    [1280, 720, undefined, 1280, 720],
    [320, 180, 640, 640, 360],
    [320, 180, 10, 114, 64], // maxSize clamped up to 64; short side raised to 64
    [3840, 2160, 99999, 3840, 2160], // clamped down to 4096 (no scaling needed)
    [320, 180, Number.NaN, 1280, 720], // invalid → 1920
  ])('%ix%i (max %s) → %ix%i', (w, h, max, ew, eh) => {
    expect(screenshotSize(w, h, max as number)).toEqual({ width: ew, height: eh });
  });

  it('normalises maxSize', () => {
    expect(normalizeMaxSize(undefined)).toBe(1920);
    expect(normalizeMaxSize('abc')).toBe(1920);
    expect(normalizeMaxSize(1000.6)).toBe(1001);
    expect(normalizeMaxSize(1)).toBe(64);
    expect(normalizeMaxSize(1e9)).toBe(4096);
  });

  it('detects integer sampling ratios', () => {
    expect(isIntegerRatio(640, 360, 1280, 720)).toBe(true);
    expect(isIntegerRatio(2560, 1440, 1280, 720)).toBe(true);
    expect(isIntegerRatio(1000, 562, 1280, 720)).toBe(false);
  });
});

describe('FrameCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('captures at the capture point at the rule size', async () => {
    const g = fakeGrabber();
    const fc = new FrameCapture(320, 180, g.grab);
    const p = fc.capture('player');
    expect(fc.queued).toBe(true);
    fc.grab(canvas(640, 360), false);
    const r = await p;
    expect(r).toMatchObject({ width: 1280, height: 720 });
    expect(g.calls).toEqual([{ w: 1280, h: 720, smooth: false }]); // 2x integer, smooth off → nearest
    expect(fc.busy).toBe(false);
  });

  it('smooths on non-integer ratios or when smooth is on', async () => {
    const g = fakeGrabber();
    const fc = new FrameCapture(320, 180, g.grab);
    let p = fc.request('game');
    fc.grab(canvas(500, 281), false);
    await p;
    p = fc.request('game');
    fc.grab(canvas(640, 360), true);
    await p;
    expect(g.calls.map((c) => c.smooth)).toEqual([true, true]);
  });

  it('grab without a queued capture does nothing', () => {
    const g = fakeGrabber();
    new FrameCapture(320, 180, g.grab).grab(canvas(320, 180), false);
    expect(g.calls).toEqual([]);
  });

  it('fails fast with busy while queued or encoding', async () => {
    let release!: (b: Blob) => void;
    const g = fakeGrabber(() => new Promise<Blob>((res) => (release = res)));
    const fc = new FrameCapture(320, 180, g.grab);
    const first = fc.capture('player');
    await expect(fc.capture('game')).resolves.toEqual({ error: 'busy' }); // queued
    fc.grab(canvas(320, 180), false);
    await expect(fc.capture('share')).resolves.toEqual({ error: 'busy' }); // encoding
    await expect(fc.request('game')).resolves.toBeNull();
    release(png());
    await expect(first).resolves.toMatchObject({ width: 1280 });
    const again = fc.capture('game');
    fc.grab(canvas(320, 180), false);
    release(png());
    await expect(again).resolves.toMatchObject({ height: 720 });
  });

  it('times out after 2000 ms without a frame (unavailable)', async () => {
    const g = fakeGrabber();
    const fc = new FrameCapture(320, 180, g.grab);
    const p = fc.capture('player');
    let settled = false;
    void p.then(() => (settled = true));
    vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ error: 'unavailable' });
    expect(fc.busy).toBe(false);
    fc.grab(canvas(320, 180), false); // late frame: nothing to do
    expect(g.calls).toEqual([]);
  });

  it('maps encoder errors, oversize blobs, throwing grabbers and lost contexts to failed', async () => {
    const cases: FrameGrabber[] = [
      () => Promise.reject(new Error('encoder')),
      () => Promise.resolve({ size: MAX_SCREENSHOT_BYTES + 1 } as Blob),
      () => {
        throw Object.assign(new Error('tainted'), { name: 'SecurityError' });
      },
    ];
    for (const grab of cases) {
      const fc = new FrameCapture(320, 180, grab);
      const p = fc.capture('player');
      fc.grab(canvas(320, 180), false);
      await expect(p).resolves.toEqual({ error: 'failed' });
    }
    const g = fakeGrabber();
    const fc = new FrameCapture(320, 180, g.grab);
    const p = fc.capture('player');
    fc.grab(canvas(320, 180), false, { isContextLost: () => true } as unknown as WebGL2RenderingContext);
    await expect(p).resolves.toEqual({ error: 'failed' });
    expect(g.calls).toEqual([]);
  });

  it('close() resolves queued and encoding captures with null and refuses later ones', async () => {
    const g = fakeGrabber(() => new Promise<Blob>(() => {}));
    const a = new FrameCapture(320, 180, g.grab);
    const queued = a.request('game');
    a.close();
    await expect(queued).resolves.toBeNull();

    const b = new FrameCapture(320, 180, g.grab);
    const encoding = b.request('game');
    b.grab(canvas(320, 180), false);
    b.close();
    await expect(encoding).resolves.toBeNull();
    await expect(b.capture('player')).resolves.toEqual({ error: 'unavailable' });
  });
});

describe('Engine capture integration', () => {
  /** An Engine without WebGL: only the fields render()/captureFrame() touch. */
  function fakeEngine(state: string) {
    const order: string[] = [];
    const g = fakeGrabber();
    const grab: FrameGrabber = (...a) => {
      order.push('grab');
      return g.grab(...a);
    };
    const renderer = {
      defaultSmooth: false,
      gl: null,
      counter: { drawCalls: 0, sprites: 0 },
      beginFrame: () => order.push('begin'),
      flush: () => order.push('flush'),
      endFrame: () => order.push('end'),
      setBlend: () => order.push('debug'),
      measureText: () => ({ width: 10 }),
      ui: (fn: () => void) => fn(),
      drawRect: () => order.push('overlay-rect'),
      drawText: () => {},
    };
    const e = Object.create(Engine.prototype) as Engine;
    Object.assign(e, {
      state,
      width: 320,
      height: 180,
      canvas: { width: 640, height: 360 },
      renderer,
      game: { render: () => order.push('game') },
      scenes: { render: () => order.push('scenes') },
      meter: { fps: 60, frameMs: 16 },
      tweens: { count: 0 },
      debugStats: { fps: 0, frameMs: 0, workMs: 0, drawCalls: 0, sprites: 0, tweens: 0, particles: 0, bodies: 0 },
      debug: true,
      pauseReasons: new Set(['host']),
      opts: {},
      capturer: new FrameCapture(320, 180, grab),
    });
    return { e, order, render: (e as unknown as { render(a: number): void }).render.bind(e) };
  }

  it('grabs after the game draw and flush, before the debug and pause overlays', async () => {
    const { e, order, render } = fakeEngine('running');
    const p = e.captureFrame();
    render(1);
    expect(order).toEqual(['begin', 'game', 'scenes', 'flush', 'grab', 'debug', 'overlay-rect', 'overlay-rect', 'end']);
    await expect(p).resolves.toBeInstanceOf(Blob);
  });

  it('answers webgame:screenshot-request from window.parent only, echoing the id', async () => {
    const parent = {};
    vi.stubGlobal('window', { parent });
    try {
      const sent: PlatformMessage[] = [];
      const { e, render } = fakeEngine('running');
      Object.assign(e, { platform: new Platform((m) => sent.push(m)) });
      const onMessage = (e as unknown as { onMessage(ev: { data: unknown; source: unknown }): void }).onMessage.bind(e);
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: 'ps-1' }, source: {} }); // not the parent
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: '' }, source: parent }); // bad id
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: 'x'.repeat(65) }, source: parent });
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: 'ps-2' }, source: parent });
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: 'ps-3' }, source: parent }); // busy
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent).toEqual([{ type: 'webgame:screenshot', requestId: 'ps-3', source: 'player', error: 'busy' }]);
      render(1);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent[1]).toMatchObject({ type: 'webgame:screenshot', requestId: 'ps-2', source: 'player', width: 1280, height: 720 });
      expect((sent[1] as { image: unknown }).image).toBeInstanceOf(Blob);

      Object.assign(e, { state: 'loading' });
      onMessage({ data: { type: 'webgame:screenshot-request', requestId: 'ps-4' }, source: parent });
      expect(sent[2]).toEqual({ type: 'webgame:screenshot', requestId: 'ps-4', source: 'player', error: 'unavailable' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('captureFrame resolves null unless running', async () => {
    for (const state of ['loading', 'error', 'destroyed']) {
      const { e } = fakeEngine(state);
      await expect(e.captureFrame()).resolves.toBeNull();
    }
  });
});
