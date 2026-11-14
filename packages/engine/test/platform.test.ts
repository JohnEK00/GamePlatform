import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEADERBOARD_TIMEOUT_MS, MAX_PENDING_LEADERBOARD, Platform, SCORE_RESULT_TIMEOUT_MS, Storage, storageHandshake,
  type HandshakeWindow, type LeaderboardView, type PlatformMessage, type ScoreResultView,
} from '../src/platform';

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

describe('F001 request/reply', () => {
  const view = (period: 'day' | 'week' | 'all'): LeaderboardView => ({
    period, order: 'desc', format: 'number', label: '', totalPlayers: 1,
    entries: [{ rank: 1, name: 'A', score: 5, display: '5', isMe: true }], me: { rank: 1, score: 5, display: '5' },
  });
  const result: ScoreResultView = { score: 5, display: '5', rank: 1, personalBest: true, ranks: { day: 1, week: 1, all: 1 } };
  function setup(hasParent = true) {
    const sent: PlatformMessage[] = [];
    const p = new Platform((m) => sent.push(m), () => hasParent);
    return { sent, p };
  }
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it('posts leaderboard-get with defaults and matches replies out of order', async () => {
    const { sent, p } = setup();
    const a = p.getLeaderboard();
    const b = p.getLeaderboard({ period: 'week', limit: 5 });
    expect(sent).toEqual([
      { type: 'webgame:leaderboard-get', requestId: 'lb-1', period: 'all', limit: 10 },
      { type: 'webgame:leaderboard-get', requestId: 'lb-2', period: 'week', limit: 5 },
    ]);
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-2', leaderboard: view('week') });
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-1', leaderboard: view('all') });
    await expect(b).resolves.toEqual(view('week'));
    await expect(a).resolves.toEqual(view('all'));
    expect(p.pendingCount).toBe(0);
  });

  it('clamps and rounds limit', () => {
    const { sent, p } = setup();
    void p.getLeaderboard({ limit: 0 });
    void p.getLeaderboard({ limit: 100 });
    void p.getLeaderboard({ limit: 7.6 });
    void p.getLeaderboard({ limit: NaN });
    expect(sent.map((m) => (m as { limit: number }).limit)).toEqual([1, 25, 8, 10]);
  });

  it('resolves null for an invalid period, with a warning, without posting', async () => {
    const { sent, p } = setup();
    await expect(p.getLeaderboard({ period: 'month' as 'day' })).resolves.toBeNull();
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('resolves null on a reply carrying error', async () => {
    const { p } = setup();
    const a = p.getLeaderboard();
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-1', leaderboard: null, error: 'rate_limited' });
    await expect(a).resolves.toBeNull();
  });

  it('times out leaderboard requests after 5s and scores after 8s', async () => {
    const { p } = setup();
    let lb: unknown = 'pending';
    let sc: unknown = 'pending';
    void p.getLeaderboard().then((v) => (lb = v));
    void p.submitScore(3).then((v) => (sc = v));
    await vi.advanceTimersByTimeAsync(LEADERBOARD_TIMEOUT_MS - 1);
    expect(lb).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(lb).toBeNull();
    expect(sc).toBe('pending');
    await vi.advanceTimersByTimeAsync(SCORE_RESULT_TIMEOUT_MS - LEADERBOARD_TIMEOUT_MS);
    expect(sc).toBeNull();
    expect(p.pendingCount).toBe(0);
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-1', leaderboard: view('all') }); // late: ignored
  });

  it('caps pending leaderboard requests at 4', async () => {
    const { sent, p } = setup();
    for (let i = 0; i < MAX_PENDING_LEADERBOARD; i++) void p.getLeaderboard();
    await expect(p.getLeaderboard()).resolves.toBeNull();
    expect(sent).toHaveLength(4);
    expect(warn).toHaveBeenCalled();
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-1', leaderboard: view('all') });
    void p.getLeaderboard();
    expect(sent).toHaveLength(5);
  });

  it('resolves null immediately without a parent', async () => {
    const { sent, p } = setup(false);
    await expect(p.getLeaderboard()).resolves.toBeNull();
    expect(sent).toEqual([]);
    await expect(p.submitScore(9)).resolves.toBeNull();
    expect(sent).toEqual([{ type: 'webgame:score', score: 9, requestId: 'sc-1' }]);
  });

  it('submitScore posts synchronously with requestId and resolves with the result', async () => {
    const { sent, p } = setup();
    const r = p.submitScore(5);
    expect(sent).toEqual([{ type: 'webgame:score', score: 5, requestId: 'sc-1' }]);
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'sc-1', leaderboard: view('all') }); // wrong type: ignored
    expect(p.pendingCount).toBe(1);
    p.handleReply({ type: 'webgame:score-result', requestId: 'sc-1', result });
    await expect(r).resolves.toEqual(result);
    const r2 = p.submitScore(6);
    p.handleReply({ type: 'webgame:score-result', requestId: 'sc-2', result: null, error: 'anonymous' });
    await expect(r2).resolves.toBeNull();
    await expect(p.submitScore(Infinity)).resolves.toBeNull();
    expect(sent).toHaveLength(2);
  });

  it('ignores replies with unknown or malformed ids', () => {
    const { p } = setup();
    void p.getLeaderboard();
    p.handleReply({ type: 'webgame:leaderboard', requestId: 'lb-99', leaderboard: view('all') });
    p.handleReply({ type: 'webgame:leaderboard', requestId: 1, leaderboard: view('all') });
    p.handleReply(null);
    p.handleReply('x');
    expect(p.pendingCount).toBe(1);
  });

  it('cancelPending (engine destroy) resolves everything with null', async () => {
    const { p } = setup();
    const a = p.getLeaderboard();
    const b = p.submitScore(1);
    p.cancelPending();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
    expect(p.pendingCount).toBe(0);
  });
});
