import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/input';

// Review round 6 L5: readGamepads() must survive a blocked / missing Gamepad API.
function fakeCanvas(): HTMLCanvasElement {
  return { style: {}, tabIndex: -1 } as unknown as HTMLCanvasElement;
}
function fakePad(pressedA: boolean): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 && pressedA, touched: false, value: i === 0 && pressedA ? 1 : 0 }));
  return { connected: true, id: 'fake pad', index: 0, axes: [0.9, 0, 0, 0], buttons } as unknown as Gamepad;
}
function expectNoPads(input: Input): void {
  for (let i = 0; i < 4; i++) {
    const p = input.gamepad(i);
    expect(p.connected).toBe(false);
    expect(p.axes).toEqual([]);
    expect(p.values).toEqual([]);
    expect(p.isDown('A')).toBe(false);
  }
  expect(input.anyPressed()).toBe(false);
}

describe('gamepad polling fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads a connected pad from navigator.getGamepads (sanity check for the stubs)', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [fakePad(true), null, null, null] });
    const input = new Input(fakeCanvas(), 320, 180);
    input.beginStep();
    expect(input.gamepad(0).connected).toBe(true);
    expect(input.gamepad(0).isDown('A')).toBe(true);
  });

  it('getGamepads throwing a SecurityError: no throw, no pads, one warning, never called again', () => {
    const getGamepads = vi.fn(() => {
      throw new DOMException('Use of the Gamepad API is disallowed by permissions policy', 'SecurityError');
    });
    vi.stubGlobal('navigator', { getGamepads });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = new Input(fakeCanvas(), 320, 180);

    expect(() => input.beginStep()).not.toThrow();
    expectNoPads(input);
    expect(getGamepads).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Gamepad');
    expect(String(warn.mock.calls[0]![1])).toContain('permissions policy');

    for (let s = 0; s < 5; s++) {
      input.endStep();
      expect(() => input.beginStep()).not.toThrow();
    }
    expectNoPads(input);
    expect(getGamepads).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a pad that was connected before getGamepads starts throwing reads as disconnected', () => {
    let blocked = false;
    const getGamepads = vi.fn(() => {
      if (blocked) throw new Error('blocked');
      return [fakePad(true)];
    });
    vi.stubGlobal('navigator', { getGamepads });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = new Input(fakeCanvas(), 320, 180);
    input.beginStep();
    expect(input.gamepad(0).connected).toBe(true);
    input.endStep();
    blocked = true;
    input.beginStep();
    expectNoPads(input);
    expect(input.axis('horizontal')).toBe(0);
  });

  it('getGamepads returning null: no throw, no pads, no warning, keeps polling', () => {
    const getGamepads = vi.fn(() => null);
    vi.stubGlobal('navigator', { getGamepads });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = new Input(fakeCanvas(), 320, 180);
    expect(() => input.beginStep()).not.toThrow();
    input.endStep();
    expect(() => input.beginStep()).not.toThrow();
    expectNoPads(input);
    expect(getGamepads).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('navigator without getGamepads: no throw, no pads, no warning', () => {
    vi.stubGlobal('navigator', {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = new Input(fakeCanvas(), 320, 180);
    expect(() => input.beginStep()).not.toThrow();
    expectNoPads(input);
    expect(input.axis('vertical')).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('no navigator at all: no throw, no pads', () => {
    vi.stubGlobal('navigator', undefined);
    const input = new Input(fakeCanvas(), 320, 180);
    expect(() => input.beginStep()).not.toThrow();
    expectNoPads(input);
  });
});
