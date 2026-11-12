import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, Storage, storageHandshake, type HandshakeWindow, type PlatformMessage } from '../src/platform';

/** A fake child window with a fake parent; `deliver` simulates a postMessage arriving. */
function mockWindow(topLevel = false) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const parent = {};
  const win: HandshakeWindow & { deliver(data: unknown, source?: unknown): void; count(): number } = {
    parent: topLevel ? (undefined as unknown) : parent,
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
    deliver(data, source = parent) {
      for (const fn of [...listeners]) fn({ data, source } as MessageEvent);
    },
    count: () => listeners.size,
  };
  if (topLevel) (win as { parent: unknown }).parent = win;
  return { win, parent };
}

describe('storage handshake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('posts hello and resolves with the parent data', async () => {
    const { win } = mockWindow();
    const sent: PlatformMessage[] = [];
    const p = storageHandshake(win, (m) => sent.push(m), 500);
    expect(sent).toEqual([{ type: 'webgame:hello' }]);
    win.deliver({ type: 'webgame:load', data: { best: 7 } }, {}); // wrong source: ignored
    win.deliver({ type: 'webgame:pause' }); // other message: ignored
    win.deliver({ type: 'webgame:load', data: { best: 42 } });
    await expect(p).resolves.toEqual({ best: 42 });
    expect(win.count()).toBe(0);
  });

  it('resolves null on timeout', async () => {
    const { win } = mockWindow();
    const sent: PlatformMessage[] = [];
    const p = storageHandshake(win, (m) => sent.push(m), 500);
    vi.advanceTimersByTime(499);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toBeNull();
    expect(win.count()).toBe(0);
    win.deliver({ type: 'webgame:load', data: { late: 1 } }); // no effect after timeout
  });

  it('treats null / non-object data as no data', async () => {
    for (const data of [null, 5, 'x', [1, 2]]) {
      const { win } = mockWindow();
      const p = storageHandshake(win, () => {}, 500);
      win.deliver({ type: 'webgame:load', data });
      await expect(p).resolves.toBeNull();
    }
  });

  it('skips the handshake without a parent', async () => {
    const { win } = mockWindow(true);
    const sent: PlatformMessage[] = [];
    await expect(storageHandshake(win, (m) => sent.push(m), 500)).resolves.toBeNull();
    await expect(storageHandshake(null, (m) => sent.push(m), 500)).resolves.toBeNull();
    expect(sent).toEqual([]);
  });

  it('seeds storage before the first read', async () => {
    const { win } = mockWindow();
    const sent: PlatformMessage[] = [];
    const storage = new Storage('g', new Platform((m) => sent.push(m)));
    const p = storageHandshake(win, (m) => sent.push(m));
    win.deliver({ type: 'webgame:load', data: { best: 99, gone: null } });
    storage.hydrate(await p);
    expect(storage.get('best')).toBe(99);
    expect(storage.get('gone', 'none')).toBe('none');
    expect(sent).toEqual([{ type: 'webgame:hello' }]);
  });
});

describe('storage saves', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces webgame:save with the full storage object', () => {
    const sent: PlatformMessage[] = [];
    const s = new Storage('g', new Platform((m) => sent.push(m)), 250);
    s.hydrate({ a: 1 });
    s.set('b', 2);
    s.set('c', [3]);
    s.remove('a');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ type: 'webgame:save', data: { b: 2, c: [3] } }]);
    s.set('b', 5);
    s.flush();
    expect(sent[1]).toEqual({ type: 'webgame:save', data: { b: 5, c: [3] } });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(2);
  });

  it('requestFullscreen posts webgame:fullscreen', () => {
    const sent: PlatformMessage[] = [];
    new Platform((m) => sent.push(m)).requestFullscreen();
    expect(sent).toEqual([{ type: 'webgame:fullscreen' }]);
  });
});
