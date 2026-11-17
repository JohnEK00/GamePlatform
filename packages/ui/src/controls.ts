// F009: controls overlay and key remapping (docs/features/F009-controls-and-remapping.md).
// Pure helpers: the bindable key table, labels, Studio validation (mirrors backend/src/bundle.rs), the on-device
// overrides store and the keyboard-layout hook. GAME_FORMAT.md § F009 is the normative source of the tables; the
// engine (packages/engine/src/actions.ts) and the backend keep their own copies.
import { useEffect, useState } from "react";
import type { ControlAction, ControlBindings, ControlOverrides, GamepadButtonName, GamepadOverrides } from "./api/types";

/**
 * Window CustomEvent a host (e.g. the desktop View → Controls menu) dispatches to open the controls panel of the
 * mounted GamePlayer or StudioPreview: `window.dispatchEvent(new CustomEvent(PLAYER_CONTROLS_EVENT))`.
 * It does nothing when no player is mounted or the game has neither actions nor a controls hint.
 */
export const PLAYER_CONTROLS_EVENT = "webgame:player-controls";

export const MAX_ACTIONS = 32;
export const MAX_ACTION_KEYS = 3;
export const MAX_ACTION_GAMEPAD = 2;
export const ACTION_NAME_MAX = 40;
export const CONTROLS_HINT_MAX = 300;
/** Max serialised size of one stored bindings entry (ARCHITECTURE § F009, raised to 8192 by § F016). */
export const CONTROLS_OVERRIDES_MAX_BYTES = 8192;
export const ACTION_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

// ---------- tables ----------

const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const DIGITS = Array.from({ length: 10 }, (_, i) => String(i));

const PUNCTUATION_LABELS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "Intl \\",
};

const KEY_LABELS: Record<string, string> = {
  ...Object.fromEntries(LETTERS.map((l) => [`Key${l}`, l])),
  ...Object.fromEntries(DIGITS.map((d) => [`Digit${d}`, d])),
  ...Object.fromEntries(DIGITS.map((d) => [`Numpad${d}`, `Num ${d}`])),
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
  NumpadEnter: "Num Enter",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ...PUNCTUATION_LABELS,
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Page Up",
  PageDown: "Page Down",
  Mouse0: "Left click",
  Mouse1: "Middle click",
  Mouse2: "Right click",
};

/** The 86 bindable codes: 83 keyboard codes (`KeyboardEvent.code`) and `Mouse0..2` (GAME_FORMAT § F009). */
export const BINDABLE_KEYS: readonly string[] = Object.freeze(Object.keys(KEY_LABELS));
const BINDABLE = new Set(BINDABLE_KEYS);

/** The 16 gamepad button names (no `Home`). */
export const GAMEPAD_BUTTON_NAMES: readonly GamepadButtonName[] = Object.freeze([
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
const GAMEPAD = new Set<string>(GAMEPAD_BUTTON_NAMES);

const GAMEPAD_LABELS: Record<string, string> = { Up: "D-pad ↑", Down: "D-pad ↓", Left: "D-pad ←", Right: "D-pad →" };

export function isBindableKey(code: unknown): code is string {
  return typeof code === "string" && BINDABLE.has(code);
}

/** A bindable keyboard code (what the remapping UI may assign; mouse codes are defaults only). */
export function isBindableKeyboardCode(code: unknown): code is string {
  return isBindableKey(code) && !code.startsWith("Mouse");
}

export function isGamepadButton(name: unknown): name is GamepadButtonName {
  return typeof name === "string" && GAMEPAD.has(name);
}

/** Codes whose label follows the keyboard layout when one is known. */
function followsLayout(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || code in PUNCTUATION_LABELS;
}

/**
 * Label of a key code. With a layout map (from `navigator.keyboard.getLayoutMap()`), letter, digit and punctuation
 * codes use the layout's character, uppercased; everything else uses the default (US) table. Unknown → the code.
 */
export function keyLabel(code: string, layout?: ReadonlyMap<string, string> | null): string {
  if (layout && followsLayout(code)) {
    const ch = layout.get(code);
    if (typeof ch === "string" && ch.trim()) return ch.toUpperCase();
  }
  return Object.hasOwn(KEY_LABELS, code) ? KEY_LABELS[code] : code;
}

export function gamepadLabel(name: string): string {
  return Object.hasOwn(GAMEPAD_LABELS, name) ? GAMEPAD_LABELS[name] : name;
}

// ---------- validation (Studio; mirrors the backend's strict rules) ----------

export type ActionsProblem = { path: string; message: string };

// Rust `char::is_control` (C0, DEL, C1) and the backend's bidi set.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI_CHARS = /[‪-‮⁦-⁩]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** "game.json: actions[2].keys[1] \"Escape\" can't be bound" — the backend's message shape. */
export function formatActionsProblem(p: ActionsProblem): string {
  // The list-size rule reads "game.json: at most 32 actions are allowed" (no path prefix).
  if (p.path === "actions" && p.message.startsWith("at most")) return `game.json: ${p.message}`;
  return `game.json: ${p.path} ${p.message}`;
}

/**
 * The backend's strict game.json `actions` rules (GAME_FORMAT § F009), for the Studio form and the publish gate.
 * Returns every problem found (the backend reports only the first). Absent or `null` → no problems.
 */
export function validateActions(manifest: unknown): ActionsProblem[] {
  const raw = isPlainObject(manifest) ? manifest.actions : undefined;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [{ path: "actions", message: "must be an array" }];
  const out: ActionsProblem[] = [];
  if (raw.length > MAX_ACTIONS) out.push({ path: "actions", message: `at most ${MAX_ACTIONS} actions are allowed` });
  const ids = new Set<string>();
  raw.forEach((a, i) => {
    const at = `actions[${i}]`;
    if (!isPlainObject(a)) {
      out.push({ path: at, message: "must be an object" });
      return;
    }
    if (typeof a.id !== "string" || !ACTION_ID_PATTERN.test(a.id)) out.push({ path: `${at}.id`, message: "must match ^[a-z0-9_-]{1,32}$" });
    else if (ids.has(a.id)) out.push({ path: `${at}.id`, message: `"${a.id}" is a duplicate` });
    else ids.add(a.id);

    if (typeof a.name !== "string") out.push({ path: `${at}.name`, message: "must be a string" });
    else {
      const name = a.name.trim();
      const len = Array.from(name).length;
      if (len < 1 || len > ACTION_NAME_MAX) out.push({ path: `${at}.name`, message: `must be 1–${ACTION_NAME_MAX} characters` });
      else if (CONTROL_CHARS.test(name) || BIDI_CHARS.test(name)) out.push({ path: `${at}.name`, message: "can't contain control or bidi characters" });
    }

    let count = 0;
    const list = (field: "keys" | "gamepad", max: number, ok: (v: string) => boolean, bad: (v: string) => string, noun: string) => {
      const v = a[field];
      if (v === undefined || v === null) return;
      if (!Array.isArray(v)) {
        out.push({ path: `${at}.${field}`, message: "must be an array" });
        return;
      }
      if (v.length > max) out.push({ path: `${at}.${field}`, message: `can have at most ${max} ${noun}` });
      const seen = new Set<string>();
      v.forEach((x, j) => {
        const p = `${at}.${field}[${j}]`;
        if (typeof x !== "string") out.push({ path: p, message: "must be a string" });
        else if (!ok(x)) out.push({ path: p, message: bad(x) });
        else if (seen.has(x)) out.push({ path: p, message: `"${x}" is a duplicate` });
        else seen.add(x);
      });
      count += v.length;
    };
    list("keys", MAX_ACTION_KEYS, isBindableKey, (x) => `"${x}" can't be bound`, "keys");
    list("gamepad", MAX_ACTION_GAMEPAD, isGamepadButton, (x) => `"${x}" is not a gamepad button`, "buttons");
    if (count === 0) out.push({ path: at, message: "needs at least one key or gamepad button" });
  });
  return out;
}

/** Problems of the action at `index` (its own and its fields'), for inline errors in a form row. */
export function problemsForAction(problems: readonly ActionsProblem[], index: number): ActionsProblem[] {
  const at = `actions[${index}]`;
  return problems.filter((p) => p.path === at || p.path.startsWith(`${at}.`));
}

// ---------- lenient parsing (what the engine accepts; also guards API data) ----------

function uniqueValid<T extends string>(v: unknown, ok: (x: unknown) => x is T, max: number): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) if (ok(x) && !out.includes(x)) out.push(x);
  return out.slice(0, max);
}

/**
 * Lenient parse of a game.json `actions` value or an API `Game.actions`: invalid entries, keys and buttons are
 * dropped, never throws. A non-array → [].
 */
export function normalizeActions(raw: unknown): ControlAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ControlAction[] = [];
  const ids = new Set<string>();
  for (const a of raw) {
    if (out.length >= MAX_ACTIONS) break;
    if (!isPlainObject(a)) continue;
    if (typeof a.id !== "string" || !ACTION_ID_PATTERN.test(a.id) || ids.has(a.id)) continue;
    if (typeof a.name !== "string") continue;
    const name = a.name.trim();
    const len = Array.from(name).length;
    if (len < 1 || len > ACTION_NAME_MAX || CONTROL_CHARS.test(name) || BIDI_CHARS.test(name)) continue;
    const keys = uniqueValid(a.keys, isBindableKey, MAX_ACTION_KEYS);
    const gamepad = uniqueValid(a.gamepad, isGamepadButton, MAX_ACTION_GAMEPAD);
    if (keys.length + gamepad.length === 0) continue;
    ids.add(a.id);
    out.push({ id: a.id, name, keys, gamepad });
  }
  return out;
}

const HINT_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const HINT_BIDI = /[‪-‮⁦-⁩]/g;

/** Lenient game.json `controls` → hint text (GAME_FORMAT § F009). Non-strings → "". */
export function normalizeControlsHint(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(HINT_CONTROL, " ").replace(HINT_BIDI, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, CONTROLS_HINT_MAX).join("").trim();
}

/** The ⌨ button / Controls section condition: at least one action or a non-empty hint. */
export function hasControls(actions: readonly ControlAction[] | undefined, hint: string | undefined): boolean {
  return (actions?.length ?? 0) > 0 || (typeof hint === "string" && hint.trim() !== "");
}

// ---------- overrides ----------

export type { ControlOverrides, GamepadOverrides, ControlBindings };

function sanitizeMap<T extends string>(raw: unknown, ok: (x: unknown) => x is T, max: number): Record<string, T[]> {
  if (!isPlainObject(raw)) return {};
  const entries: [string, T[]][] = [];
  for (const id of Object.keys(raw)) {
    if (entries.length >= MAX_ACTIONS) break;
    const v = raw[id];
    if (!ACTION_ID_PATTERN.test(id) || !Array.isArray(v)) continue;
    entries.push([id, uniqueValid(v, ok, max)]);
  }
  // Object.fromEntries defines own data properties, so an id like "__proto__" can't touch the prototype.
  return Object.fromEntries(entries);
}

/**
 * Sanitises an overrides object: ids matching the action id rule, array values only, bindable codes, de-duplicated,
 * at most 3 per action and 32 actions. Anything else → {}.
 */
export function sanitizeOverrides(raw: unknown): ControlOverrides {
  return sanitizeMap(raw, isBindableKey, MAX_ACTION_KEYS);
}

/**
 * F016: sanitises gamepad overrides: ids matching the action id rule, array values only, names from the gamepad table
 * (no `Home`), de-duplicated, at most 2 per action and 32 actions. Anything else → {}.
 */
export function sanitizeGamepadOverrides(raw: unknown): GamepadOverrides {
  return sanitizeMap(raw, isGamepadButton, MAX_ACTION_GAMEPAD);
}

/** F016: `{ keys, gamepad }`, each sanitised. A non-object (or `null`) → both empty. */
export function sanitizeBindings(raw: unknown): ControlBindings {
  const o = isPlainObject(raw) ? raw : {};
  return { keys: sanitizeOverrides(o.keys), gamepad: sanitizeGamepadOverrides(o.gamepad) };
}

/** F016: a fresh, empty `ControlBindings`. */
export function emptyBindings(): ControlBindings {
  return { keys: {}, gamepad: {} };
}

/** True when neither keys nor gamepad buttons are overridden. */
export function isEmptyBindings(b: ControlBindings): boolean {
  return Object.keys(b.keys).length === 0 && Object.keys(b.gamepad).length === 0;
}

/** Same ids, in the same order, with the same values in the same order. */
export function sameBindings(a: ControlBindings, b: ControlBindings): boolean {
  return JSON.stringify(a.keys) === JSON.stringify(b.keys) && JSON.stringify(a.gamepad) === JSON.stringify(b.gamepad);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Defaults with the overrides applied (the engine's `applyOverrides`): for each declared action with an array
 * override, `keys` becomes its valid, de-duplicated bindable codes (first 3) and, with F016 `gamepad` overrides,
 * `gamepad` becomes its valid, de-duplicated button names (first 2). `[]` means "none"; anything invalid is ignored.
 */
export function effectiveActions(defaults: readonly ControlAction[], overrides: unknown, gamepad?: unknown): ControlAction[] {
  const o = isPlainObject(overrides) ? overrides : {};
  const g = isPlainObject(gamepad) ? gamepad : {};
  return defaults.map((a) => {
    const k = Object.hasOwn(o, a.id) ? o[a.id] : undefined;
    const p = Object.hasOwn(g, a.id) ? g[a.id] : undefined;
    if (!Array.isArray(k) && !Array.isArray(p)) return a;
    return {
      ...a,
      keys: Array.isArray(k) ? uniqueValid(k, isBindableKey, MAX_ACTION_KEYS) : a.keys,
      gamepad: Array.isArray(p) ? uniqueValid(p, isGamepadButton, MAX_ACTION_GAMEPAD) : a.gamepad,
    };
  });
}

function pruneMap<T extends string>(clean: Record<string, T[]>, defaults: readonly ControlAction[], field: "keys" | "gamepad"): Record<string, T[]> {
  return Object.fromEntries(
    defaults.filter((a) => Object.hasOwn(clean, a.id) && !sameKeys(clean[a.id], a[field])).map((a) => [a.id, clean[a.id]] as [string, T[]]),
  );
}

/**
 * Overrides reduced to what is worth storing / sending: only declared ids (in manifest order), only entries whose
 * keys differ from the defaults. Without `defaults`, only sanitised.
 */
export function pruneOverrides(overrides: unknown, defaults?: readonly ControlAction[]): ControlOverrides {
  const clean = sanitizeOverrides(overrides);
  return defaults ? pruneMap(clean, defaults, "keys") : clean;
}

/** F016: gamepad overrides reduced like {@link pruneOverrides}. */
export function pruneGamepadOverrides(gamepad: unknown, defaults?: readonly ControlAction[]): GamepadOverrides {
  const clean = sanitizeGamepadOverrides(gamepad);
  return defaults ? pruneMap(clean, defaults, "gamepad") : clean;
}

/**
 * F016: bindings reduced to what is worth storing / sending: sanitised, and with `defaults`, only declared ids (manifest
 * order) and only entries that differ from that action's defaults, for keys and gamepad separately.
 */
export function pruneBindings(bindings: unknown, defaults?: readonly ControlAction[]): ControlBindings {
  const clean = sanitizeBindings(bindings);
  return { keys: pruneOverrides(clean.keys, defaults), gamepad: pruneGamepadOverrides(clean.gamepad, defaults) };
}

/** True when the action's effective keys (or, with F016 `gamepad` overrides, its gamepad buttons) differ from its defaults. */
export function isActionChanged(action: ControlAction, overrides: ControlOverrides, gamepad?: GamepadOverrides): boolean {
  const keys = Object.hasOwn(overrides, action.id) && !sameKeys(uniqueValid(overrides[action.id], isBindableKey, MAX_ACTION_KEYS), action.keys);
  if (keys || !gamepad) return keys;
  return Object.hasOwn(gamepad, action.id) && !sameKeys(uniqueValid(gamepad[action.id], isGamepadButton, MAX_ACTION_GAMEPAD), action.gamepad);
}

/**
 * For each action id, the ids of the other actions that share at least one key or at least one gamepad button
 * (one combined list, manifest order, no duplicates). Keys are compared with keys and buttons with buttons.
 */
export function findConflicts(actions: readonly ControlAction[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of actions) {
    const others = actions
      .filter((b) => b.id !== a.id && (b.keys.some((k) => a.keys.includes(k)) || b.gamepad.some((g) => a.gamepad.includes(g))))
      .map((b) => b.id);
    if (others.length) Object.defineProperty(out, a.id, { value: others, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** True when some action uses a Ctrl key and some action uses W, T or N (browsers reserve Ctrl+W/T/N). */
export function hasCtrlShortcutRisk(actions: readonly ControlAction[]): boolean {
  const all = actions.flatMap((a) => a.keys);
  return all.some((k) => k === "ControlLeft" || k === "ControlRight") && all.some((k) => k === "KeyW" || k === "KeyT" || k === "KeyN");
}

// ---------- on-device store ----------

export function controlsStorageKey(gameId: string): string {
  return `webgame.controls.${gameId}`;
}
export function controlsHintedKey(gameId: string): string {
  return `webgame.controls.hinted.${gameId}`;
}

/** Session fallback when localStorage throws (disabled storage, quota). `null` = "removed". */
const memory = new Map<string, string | null>();
const listeners = new Map<string, Set<(b: ControlBindings) => void>>();

function storageGet(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

/** A parsed device entry (ARCHITECTURE § F016 "Device store"). */
type StoredEntry = { bindings: ControlBindings; unsynced: string | null };

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * `{ v: 1, overrides, gamepad?, unsynced? }`. Malformed JSON, `v !== 1`, a non-object `overrides` or an oversize entry
 * → null (the caller removes the key). A missing or non-object `gamepad` reads as {}, and an `unsynced` that is not a
 * non-empty string as absent, so entries written by F009 code stay valid.
 */
function parseStored(raw: string | null): StoredEntry | null {
  if (raw === null) return { bindings: emptyBindings(), unsynced: null };
  if (byteLength(raw) > CONTROLS_OVERRIDES_MAX_BYTES) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isPlainObject(v) || v.v !== 1 || !isPlainObject(v.overrides)) return null;
    return {
      bindings: { keys: sanitizeOverrides(v.overrides), gamepad: sanitizeGamepadOverrides(v.gamepad) },
      unsynced: typeof v.unsynced === "string" && v.unsynced !== "" ? v.unsynced : null,
    };
  } catch {
    return null;
  }
}

function readEntry(gameId: string): StoredEntry {
  const key = controlsStorageKey(gameId);
  const parsed = parseStored(storageGet(key));
  if (parsed) return parsed;
  storageSet(key, null);
  return { bindings: emptyBindings(), unsynced: null };
}

/** F016: the stored bindings (keys and gamepad) of a game on this device. Bad entries → empty (and removed). */
export function readBindings(gameId: string): ControlBindings {
  return readEntry(gameId).bindings;
}

/** F016: the id of the signed-in user whose latest change on this device is not yet confirmed by a `PUT`, or null. */
export function readUnsynced(gameId: string): string | null {
  return readEntry(gameId).unsynced;
}

/** The stored key overrides of a game on this device. Malformed, unknown-version or oversize entries → {} (and removed). */
export function readOverrides(gameId: string): ControlOverrides {
  return readBindings(gameId).keys;
}

/**
 * F016: stores a game's bindings and notifies subscribers when they changed. With `defaults` (the game's declared
 * actions), ids that are no longer declared and entries equal to the defaults are dropped (keys and gamepad
 * separately). `opts.unsynced`: a user id sets the marker, `null` clears it, absent keeps the stored one. The key is
 * removed only when the bindings are empty and no marker is left. Returns the stored bindings. When localStorage
 * throws, the value is kept in memory for this session.
 */
export function writeBindings(
  gameId: string,
  bindings: unknown,
  defaults?: readonly ControlAction[],
  opts: { unsynced?: string | null } = {},
): ControlBindings {
  const key = controlsStorageKey(gameId);
  const prev = readEntry(gameId);
  const clean = pruneBindings(bindings, defaults);
  const unsynced = opts.unsynced === undefined ? prev.unsynced : opts.unsynced || null;
  if (isEmptyBindings(clean) && !unsynced) storageSet(key, null);
  else {
    const entry: Record<string, unknown> = { v: 1, overrides: clean.keys };
    if (Object.keys(clean.gamepad).length > 0) entry.gamepad = clean.gamepad;
    if (unsynced) entry.unsynced = unsynced;
    // Sanitised bindings (32 ids × (3 codes + 2 names)) stay well under the cap; the check guards future table changes.
    const json = JSON.stringify(entry);
    storageSet(key, byteLength(json) > CONTROLS_OVERRIDES_MAX_BYTES ? null : json);
  }
  if (!sameBindings(prev.bindings, clean)) notify(gameId, clean);
  return clean;
}

/**
 * Stores a game's key overrides (F009 API) and notifies subscribers. The stored gamepad overrides and sync marker are
 * kept. Returns the stored key overrides.
 */
export function writeOverrides(gameId: string, overrides: unknown, defaults?: readonly ControlAction[]): ControlOverrides {
  return writeBindings(gameId, { keys: overrides, gamepad: readBindings(gameId).gamepad }, defaults).keys;
}

function notify(gameId: string, b: ControlBindings) {
  const set = listeners.get(gameId);
  if (set) [...set].forEach((fn) => fn(b));
}

/**
 * F016: calls `fn` with the new bindings whenever they change in this window (`writeBindings`, `writeOverrides`) or in
 * another tab of the same origin (the `storage` event). Returns the unsubscribe function.
 */
export function subscribeBindings(gameId: string, fn: (bindings: ControlBindings) => void): () => void {
  let set = listeners.get(gameId);
  if (!set) listeners.set(gameId, (set = new Set()));
  set.add(fn);
  const key = controlsStorageKey(gameId);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key && e.key !== null) return;
    memory.delete(key);
    fn(readBindings(gameId));
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    set!.delete(fn);
    if (set!.size === 0 && listeners.get(gameId) === set) listeners.delete(gameId);
  };
}

/**
 * F016 shared devices: where another signed-in user's unconfirmed change is set aside while someone else plays.
 * Same format as the main entry, without `unsynced` (the key names the owner).
 */
export function controlsParkedKey(gameId: string, userId: string): string {
  return `webgame.controls.${gameId}.pending.${userId}`;
}

/**
 * F016: if the device entry holds an unconfirmed change of a user other than `userId`, moves those bindings aside
 * under {@link controlsParkedKey} for their owner and clears the device entry (subscribers are told, so the game falls
 * back to the defaults). Returns the owner's id, or null when nothing was moved.
 */
export function parkOtherUsersChange(gameId: string, userId: string): string | null {
  const entry = readEntry(gameId);
  if (entry.unsynced === null || entry.unsynced === userId) return null;
  const owner = entry.unsynced;
  const b = entry.bindings;
  const value: Record<string, unknown> = { v: 1, overrides: b.keys };
  if (Object.keys(b.gamepad).length > 0) value.gamepad = b.gamepad;
  storageSet(controlsParkedKey(gameId, owner), JSON.stringify(value));
  writeBindings(gameId, emptyBindings(), undefined, { unsynced: null });
  return owner;
}

/** F016: removes and returns `userId`'s parked bindings for a game, or null when there are none (or they are malformed). */
export function takeParkedChange(gameId: string, userId: string): ControlBindings | null {
  const key = controlsParkedKey(gameId, userId);
  const raw = storageGet(key);
  if (raw === null) return null;
  storageSet(key, null);
  return parseStored(raw)?.bindings ?? null;
}

/** Like {@link subscribeBindings}, with the key overrides only (F009 API). */
export function subscribeOverrides(gameId: string, fn: (overrides: ControlOverrides) => void): () => void {
  return subscribeBindings(gameId, (b) => fn(b.keys));
}

/** F016 React hook: the stored bindings of a game, updated live. */
export function useStoredBindings(gameId: string): ControlBindings {
  const [state, setState] = useState(() => ({ gameId, value: readBindings(gameId) }));
  useEffect(() => {
    setState({ gameId, value: readBindings(gameId) });
    return subscribeBindings(gameId, (value) => setState({ gameId, value }));
  }, [gameId]);
  return state.gameId === gameId ? state.value : readBindings(gameId);
}

/** React hook: the stored key overrides of a game, updated live (F009 API). */
export function useStoredOverrides(gameId: string): ControlOverrides {
  return useStoredBindings(gameId).keys;
}

/** True (and remembered) the first time it is called for a game on this device: the one-time first-play hint. */
export function takeControlsHint(gameId: string): boolean {
  const key = controlsHintedKey(gameId);
  if (storageGet(key) === "1") return false;
  storageSet(key, "1");
  return true;
}

/** Test helper: forgets the in-memory fallback and listeners. */
export function resetControlsStoreForTests(): void {
  memory.clear();
  listeners.clear();
  layoutValue = undefined;
  layoutPromise = null;
}

// ---------- keyboard layout (labels in the parent's own UI only; never sent to a game) ----------

type KeyboardLayoutMapLike = { forEach: (cb: (value: string, key: string) => void) => void };
type KeyboardApi = { getLayoutMap?: () => Promise<KeyboardLayoutMapLike> };

let layoutValue: Map<string, string> | null | undefined;
let layoutPromise: Promise<Map<string, string> | null> | null = null;

function loadLayout(): Promise<Map<string, string> | null> {
  if (layoutPromise) return layoutPromise;
  const kb = (typeof navigator !== "undefined" ? (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard : undefined) ?? undefined;
  if (!kb || typeof kb.getLayoutMap !== "function") {
    layoutValue = null;
    layoutPromise = Promise.resolve(null);
    return layoutPromise;
  }
  layoutPromise = kb.getLayoutMap().then(
    (m) => {
      const out = new Map<string, string>();
      m.forEach((value, key) => {
        if (typeof value === "string" && typeof key === "string") out.set(key, value);
      });
      layoutValue = out;
      return out;
    },
    () => {
      layoutValue = null;
      return null;
    },
  );
  return layoutPromise;
}

/**
 * The keyboard layout map (`navigator.keyboard.getLayoutMap()`, Chromium/WebView2), resolved once per app session,
 * or null where unavailable. Use it for labels in the app's own UI only: it must never be posted into a game iframe.
 */
export function useKeyboardLayout(): Map<string, string> | null {
  const [layout, setLayout] = useState<Map<string, string> | null>(() => layoutValue ?? null);
  useEffect(() => {
    if (layoutValue !== undefined) {
      setLayout(layoutValue);
      return;
    }
    let alive = true;
    void loadLayout().then((m) => {
      if (alive) setLayout(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return layout;
}

export type ControlsMessage = { type: "webgame:controls"; overrides: ControlOverrides; gamepad: GamepadOverrides };

/**
 * The message posted to the game iframe (GAME_FORMAT § F016): declared action ids, key codes and gamepad button names
 * only, both pruned against the defaults. `gamepad` is always present (possibly {}), so each message replaces both
 * sets. No labels, no layout, no `Gamepad.id`, no user data, no sync state.
 */
export function controlsMessage(defaults: readonly ControlAction[], bindings: ControlBindings): ControlsMessage {
  const b = pruneBindings(bindings, defaults);
  return { type: "webgame:controls", overrides: b.keys, gamepad: b.gamepad };
}
