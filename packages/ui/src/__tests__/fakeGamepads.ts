// Test helper (F016): a fake `navigator.getGamepads` plus a manual requestAnimationFrame queue, so gamepad capture
// tests are deterministic. `frame()` runs the callbacks queued so far, inside act().
import { act } from "@testing-library/react";

type Pad = { id: string; mapping: string; pressed: Set<number> };

export type FakeGamepads = {
  connect: (index: number, opts?: { id?: string; mapping?: string; pressed?: number[] }) => void;
  disconnect: (index: number) => void;
  press: (index: number, button: number) => void;
  release: (index: number, button: number) => void;
  /** Makes `getGamepads` throw a SecurityError from now on. */
  failWith: (err: unknown) => void;
  /** Runs the animation-frame callbacks queued so far. */
  frame: () => void;
  /** Number of queued animation-frame callbacks. */
  pending: () => number;
  /** How many times `getGamepads` was called. */
  calls: () => number;
  /** Removes `navigator.getGamepads` and restores requestAnimationFrame. Idempotent. */
  uninstall: () => void;
};

const BUTTONS = 17;

export function installFakeGamepads(): FakeGamepads {
  const pads = new Map<number, Pad>();
  let error: unknown = null;
  let calls = 0;
  let nextHandle = 1;
  const queue = new Map<number, () => void>();
  const g = globalThis as unknown as Record<string, unknown>;
  const savedRaf = g.requestAnimationFrame;
  const savedCaf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: () => void) => {
    const h = nextHandle++;
    queue.set(h, cb);
    return h;
  };
  g.cancelAnimationFrame = (h: number) => {
    queue.delete(h);
  };
  const getGamepads = () => {
    calls++;
    if (error) throw error;
    return Array.from({ length: 4 }, (_, index) => {
      const p = pads.get(index);
      if (!p) return null;
      return {
        index,
        id: p.id,
        mapping: p.mapping,
        connected: true,
        buttons: Array.from({ length: BUTTONS }, (_, i) => ({ pressed: p.pressed.has(i), value: p.pressed.has(i) ? 1 : 0 })),
      };
    });
  };
  Object.defineProperty(navigator, "getGamepads", { configurable: true, writable: true, value: getGamepads });
  let installed = true;

  return {
    connect: (index, opts = {}) => {
      pads.set(index, { id: opts.id ?? `Pad ${index}`, mapping: opts.mapping ?? "standard", pressed: new Set(opts.pressed ?? []) });
    },
    disconnect: (index) => {
      pads.delete(index);
    },
    press: (index, button) => {
      pads.get(index)!.pressed.add(button);
    },
    release: (index, button) => {
      pads.get(index)!.pressed.delete(button);
    },
    failWith: (err) => {
      error = err;
    },
    frame: () => {
      const cbs = [...queue.values()];
      queue.clear();
      act(() => {
        for (const cb of cbs) cb();
      });
    },
    pending: () => queue.size,
    calls: () => calls,
    uninstall: () => {
      if (!installed) return;
      installed = false;
      queue.clear();
      delete (navigator as unknown as Record<string, unknown>).getGamepads;
      g.requestAnimationFrame = savedRaf;
      g.cancelAnimationFrame = savedCaf;
    },
  };
}
