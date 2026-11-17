// F016: gamepad capture for the controls panel (GAME_FORMAT.md § F016 "Parent capture").
// Pure polling logic plus one requestAnimationFrame loop. The parent reads gamepads only while a slot is capturing.
// `Gamepad.id` is used only inside the in-memory baseline key (index + id) and never leaves this module.
import type { GamepadButtonName } from "./api/types";

/** Standard-mapping button indices 0–15 (index 16 is `Home`, which can't be bound). */
export const STANDARD_GAMEPAD_BUTTONS: readonly GamepadButtonName[] = Object.freeze([
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "LT",
  "RT",
  "Back",
  "Start",
  "LS",
  "RS",
  "Up",
  "Down",
  "Left",
  "Right",
] as GamepadButtonName[]);

/**
 * Inline messages while capture continues:
 * - `"no-controller"`: no controller was seen when capture started (the first press may only wake it).
 * - `"unusable-button"`: `Home` (16) or a higher index was pressed.
 * - `"unsupported-controller"`: a press on a controller whose `mapping` is not `"standard"`.
 */
export type GamepadCaptureMessage = "no-controller" | "unusable-button" | "unsupported-controller";

/** The parts of `Gamepad` capture reads. */
export type GamepadLike = {
  index: number;
  id: string;
  mapping: string;
  connected?: boolean;
  buttons: ArrayLike<{ pressed: boolean } | null | undefined>;
};

export type GamepadCaptureOptions = {
  /** The first counted button: capture has already stopped when this is called. */
  onButton: (name: GamepadButtonName) => void;
  onMessage: (kind: GamepadCaptureMessage) => void;
  /** The Gamepad API is missing or throws (e.g. a `SecurityError` on a non-secure origin): capture has stopped. */
  onUnavailable: () => void;
  /** Test seams. Default: `navigator.getGamepads`, `requestAnimationFrame`, `cancelAnimationFrame`. */
  getGamepads?: () => ArrayLike<GamepadLike | null | undefined>;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

function defaultGetGamepads(): (() => ArrayLike<GamepadLike | null | undefined>) | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { getGamepads?: () => ArrayLike<GamepadLike | null> };
  if (typeof nav.getGamepads !== "function") return null;
  return () => nav.getGamepads!();
}

function pressedSet(pad: GamepadLike): Set<number> {
  const out = new Set<number>();
  const n = pad.buttons?.length ?? 0;
  for (let i = 0; i < n; i++) if (pad.buttons[i]?.pressed === true) out.add(i);
  return out;
}

/**
 * Starts polling `navigator.getGamepads()` once per animation frame and returns the stop function (idempotent).
 *
 * Per pad (keyed by `index` and `id`, in memory only), the buttons pressed when capture starts or when the pad is
 * first seen are a baseline: they count only after a release and a fresh press. A button counts when `pressed` goes
 * from false to true on a pad with `mapping === "standard"`; indices 0–15 are assigned (capture stops), 16+ report
 * `"unusable-button"`, and presses on other mappings report `"unsupported-controller"`.
 */
export function startGamepadCapture(opts: GamepadCaptureOptions): () => void {
  const getGamepads = opts.getGamepads ?? defaultGetGamepads();
  const requestFrame = opts.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelFrame = opts.cancelFrame ?? ((h: number) => cancelAnimationFrame(h));
  let stopped = false;
  let frame: number | null = null;
  /** Baseline / last-seen pressed buttons per pad. Keys hold `Gamepad.id`: never exposed. */
  const pads = new Map<string, Set<number>>();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pads.clear();
  };

  const read = (): GamepadLike[] | null => {
    try {
      const list = getGamepads ? getGamepads() : null;
      if (!list) return null;
      const out: GamepadLike[] = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p && p.connected !== false) out.push(p);
      }
      return out;
    } catch {
      return null;
    }
  };

  const unavailable = () => {
    stop();
    opts.onUnavailable();
  };

  const initial = getGamepads ? read() : null;
  if (!initial) {
    unavailable();
    return stop;
  }
  for (const p of initial) pads.set(`${p.index}|${p.id}`, pressedSet(p));
  if (initial.length === 0) opts.onMessage("no-controller");

  const poll = () => {
    frame = null;
    if (stopped) return;
    const list = read();
    if (!list) return unavailable();
    const seen = new Set<string>();
    for (const p of list) {
      const key = `${p.index}|${p.id}`;
      seen.add(key);
      const now = pressedSet(p);
      const before = pads.get(key);
      pads.set(key, now);
      // First sighting (often the wake-up press): everything held is baseline.
      if (!before) continue;
      for (const i of [...now].sort((a, b) => a - b)) {
        if (before.has(i)) continue;
        if (p.mapping !== "standard") {
          opts.onMessage("unsupported-controller");
          break;
        }
        if (i >= STANDARD_GAMEPAD_BUTTONS.length) {
          opts.onMessage("unusable-button");
          continue;
        }
        const name = STANDARD_GAMEPAD_BUTTONS[i];
        stop();
        opts.onButton(name);
        return;
      }
    }
    // A pad that went away is "first seen" again when it comes back.
    for (const key of [...pads.keys()]) if (!seen.has(key)) pads.delete(key);
    if (!stopped) frame = requestFrame(poll);
  };
  frame = requestFrame(poll);
  return stop;
}
