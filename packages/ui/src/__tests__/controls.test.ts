import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlAction } from "../api/types";
import {
  BINDABLE_KEYS,
  CONTROLS_OVERRIDES_MAX_BYTES,
  isActionChanged,
  pruneBindings,
  readBindings,
  readUnsynced,
  sanitizeBindings,
  sanitizeGamepadOverrides,
  subscribeBindings,
  writeBindings,
  controlsMessage,
  controlsStorageKey,
  effectiveActions,
  findConflicts,
  formatActionsProblem,
  GAMEPAD_BUTTON_NAMES,
  gamepadLabel,
  hasControls,
  hasCtrlShortcutRisk,
  keyLabel,
  normalizeActions,
  normalizeControlsHint,
  readOverrides,
  resetControlsStoreForTests,
  subscribeOverrides,
  takeControlsHint,
  validateActions,
  writeOverrides,
} from "../controls";
import { STUDIO_TEMPLATES } from "../studio/templates";

afterEach(() => {
  resetControlsStoreForTests();
  vi.restoreAllMocks();
});

const act = (id: string, keys: string[], gamepad: string[] = [], name = id): ControlAction => ({ id, name, keys, gamepad: gamepad as ControlAction["gamepad"] });

describe("tables and labels", () => {
  it("has 86 bindable codes and 16 gamepad buttons", () => {
    expect(BINDABLE_KEYS).toHaveLength(86);
    expect(BINDABLE_KEYS.filter((k) => k.startsWith("Mouse"))).toEqual(["Mouse0", "Mouse1", "Mouse2"]);
    expect(new Set(BINDABLE_KEYS).size).toBe(86);
    for (const bad of ["Escape", "Tab", "F1", "F5", "F24", "MetaLeft", "MetaRight", "CapsLock", "ContextMenu", "PrintScreen", "ScrollLock", "Pause", "NumLock"])
      expect(BINDABLE_KEYS).not.toContain(bad);
    expect(GAMEPAD_BUTTON_NAMES).toHaveLength(16);
    expect(GAMEPAD_BUTTON_NAMES).not.toContain("Home");
  });

  it("labels keys with the default table", () => {
    expect(keyLabel("KeyA")).toBe("A");
    expect(keyLabel("Digit7")).toBe("7");
    expect(keyLabel("Numpad3")).toBe("Num 3");
    expect(keyLabel("NumpadEnter")).toBe("Num Enter");
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("ShiftLeft")).toBe("Left Shift");
    expect(keyLabel("ControlRight")).toBe("Right Ctrl");
    expect(keyLabel("Backslash")).toBe("\\");
    expect(keyLabel("IntlBackslash")).toBe("Intl \\");
    expect(keyLabel("Backquote")).toBe("`");
    expect(keyLabel("PageDown")).toBe("Page Down");
    expect(keyLabel("Mouse0")).toBe("Left click");
    expect(keyLabel("Mouse2")).toBe("Right click");
    expect(keyLabel("Space")).toBe("Space");
    expect(keyLabel("F5")).toBe("F5");
    expect(keyLabel("__proto__")).toBe("__proto__");
    expect(gamepadLabel("A")).toBe("A");
    expect(gamepadLabel("Up")).toBe("D-pad ↑");
    expect(gamepadLabel("Right")).toBe("D-pad →");
    expect(gamepadLabel("Home")).toBe("Home");
  });

  it("uses the layout for letters, digits and punctuation only", () => {
    const azerty = new Map([
      ["KeyW", "z"],
      ["KeyQ", "a"],
      ["Digit1", "&"],
      ["Semicolon", "m"],
      ["Space", " "],
      ["ArrowUp", "x"],
      ["KeyE", ""],
    ]);
    expect(keyLabel("KeyW", azerty)).toBe("Z");
    expect(keyLabel("KeyQ", azerty)).toBe("A");
    expect(keyLabel("Digit1", azerty)).toBe("&");
    expect(keyLabel("Semicolon", azerty)).toBe("M");
    expect(keyLabel("Space", azerty)).toBe("Space");
    expect(keyLabel("ArrowUp", azerty)).toBe("↑");
    expect(keyLabel("KeyE", azerty)).toBe("E"); // empty → default
    expect(keyLabel("KeyD", azerty)).toBe("D"); // missing → default
    expect(keyLabel("KeyW", null)).toBe("W");
  });
});

describe("validateActions (backend rules)", () => {
  const ok = { id: "jump", name: "Jump", keys: ["Space"], gamepad: ["A"] };
  const v = (actions: unknown) => validateActions({ name: "x", actions });
  const msgs = (actions: unknown) => v(actions).map(formatActionsProblem);

  it("accepts valid, absent and null actions", () => {
    expect(validateActions({})).toEqual([]);
    expect(v(null)).toEqual([]);
    expect(v([ok, { id: "fire", name: "  Fire  ", keys: ["Mouse0", "KeyZ"] }, { id: "pad", name: "Pad", gamepad: ["Start"] }])).toEqual([]);
    expect(v([{ ...ok, extra: 1 }])).toEqual([]); // unknown keys inside an action are ignored
  });

  it("rejects a non-array and more than 32 actions", () => {
    expect(msgs({})).toEqual(["game.json: actions must be an array"]);
    expect(msgs("jump")).toEqual(["game.json: actions must be an array"]);
    const many = Array.from({ length: 33 }, (_, i) => ({ id: `a${i}`, name: "A", keys: ["KeyA"] }));
    expect(msgs(many)).toContain("game.json: at most 32 actions are allowed");
  });

  it("rejects bad and duplicate ids", () => {
    expect(msgs([{ ...ok, id: "Jump" }])).toEqual(["game.json: actions[0].id must match ^[a-z0-9_-]{1,32}$"]);
    expect(msgs([{ ...ok, id: "x".repeat(33) }])).toEqual(["game.json: actions[0].id must match ^[a-z0-9_-]{1,32}$"]);
    expect(msgs([{ ...ok, id: 3 }])).toEqual(["game.json: actions[0].id must match ^[a-z0-9_-]{1,32}$"]);
    expect(msgs([ok, ok])).toEqual(['game.json: actions[1].id "jump" is a duplicate']);
  });

  it("rejects bad names", () => {
    expect(v([{ ...ok, name: "   " }])[0].path).toBe("actions[0].name");
    expect(v([{ ...ok, name: "x".repeat(41) }])[0].path).toBe("actions[0].name");
    expect(v([{ ...ok, name: "x".repeat(40) }])).toEqual([]);
    expect(v([{ ...ok, name: "a\u0007b" }])[0].message).toMatch(/control/);
    expect(v([{ ...ok, name: "a‮b" }])[0].message).toMatch(/bidi/);
    expect(v([{ ...ok, name: 5 }])[0].path).toBe("actions[0].name");
  });

  it("rejects bad keys", () => {
    for (const bad of ["Escape", "Tab", "F5", "MetaLeft"])
      expect(msgs([{ ...ok, keys: ["Space", bad] }])).toEqual([`game.json: actions[0].keys[1] "${bad}" can't be bound`]);
    expect(msgs([{ ...ok, keys: [7] }])).toEqual(["game.json: actions[0].keys[0] must be a string"]);
    expect(msgs([{ ...ok, keys: ["KeyA", "KeyA"] }])).toEqual(['game.json: actions[0].keys[1] "KeyA" is a duplicate']);
    expect(v([{ ...ok, keys: ["KeyA", "KeyB", "KeyC", "KeyD"] }])[0]).toEqual({ path: "actions[0].keys", message: "can have at most 3 keys" });
    expect(v([{ ...ok, keys: "Space" }])[0]).toEqual({ path: "actions[0].keys", message: "must be an array" });
  });

  it("rejects bad gamepad buttons and missing bindings", () => {
    expect(msgs([{ ...ok, gamepad: ["Home"] }])).toEqual(['game.json: actions[0].gamepad[0] "Home" is not a gamepad button']);
    expect(v([{ ...ok, gamepad: ["A", "B", "X"] }])[0]).toEqual({ path: "actions[0].gamepad", message: "can have at most 2 buttons" });
    expect(msgs([{ id: "x", name: "X" }])).toEqual(["game.json: actions[0] needs at least one key or gamepad button"]);
    expect(msgs([{ id: "x", name: "X", keys: [], gamepad: [] }])).toEqual(["game.json: actions[0] needs at least one key or gamepad button"]);
    expect(msgs(["jump"])).toEqual(["game.json: actions[0] must be an object"]);
  });

  it("every Studio template declares valid actions", () => {
    for (const t of STUDIO_TEMPLATES) {
      expect(validateActions(t.manifest)).toEqual([]);
      expect(normalizeActions(t.manifest.actions).length).toBeGreaterThan(0);
      expect(t.files["main.js"]).toMatch(/action(Pressed|Down)\(/);
    }
  });

  it("the Menu & HUD template declares confirm and drives its menus with engine.ui (F012)", () => {
    const t = STUDIO_TEMPLATES.find((x) => x.id === "menu-hud")!;
    expect(validateActions(t.manifest)).toEqual([]);
    expect(normalizeActions(t.manifest.actions).map((a) => a.id)).toContain("confirm");
    expect(t.files["main.js"]).toContain("engine.ui.button(");
    // F016: its prompts follow the last device.
    expect(t.files["main.js"]).toContain('actionLabel(id, "auto")');
  });
});

describe("lenient parsing", () => {
  it("normalizeActions drops invalid entries, keys and buttons", () => {
    const out = normalizeActions([
      { id: "jump", name: " Jump ", keys: ["Space", "Escape", "Space", "KeyW", "KeyK", "KeyL"], gamepad: ["Home", "A", "B", "X"] },
      { id: "jump", name: "Dup", keys: ["KeyA"] },
      { id: "BAD", name: "Bad", keys: ["KeyA"] },
      { id: "none", name: "None", keys: ["Escape"] },
      "x",
    ]);
    expect(out).toEqual([{ id: "jump", name: "Jump", keys: ["Space", "KeyW", "KeyK"], gamepad: ["A", "B"] }]);
    expect(normalizeActions(undefined)).toEqual([]);
    expect(normalizeActions({})).toEqual([]);
  });

  it("normalizeControlsHint", () => {
    expect(normalizeControlsHint("  Arrows\nmove,\t\tSpace   shoots ")).toBe("Arrows move, Space shoots");
    expect(normalizeControlsHint("a‮b")).toBe("ab");
    expect(normalizeControlsHint(42)).toBe("");
    expect(normalizeControlsHint("x".repeat(500))).toHaveLength(300);
    expect(hasControls([], "")).toBe(false);
    expect(hasControls([], " hi ")).toBe(true);
    expect(hasControls([act("a", ["KeyA"])], "")).toBe(true);
  });
});

describe("overrides", () => {
  const defaults = [act("jump", ["Space", "ArrowUp"], ["A"]), act("fire", ["KeyZ"])];

  it("effectiveActions replaces keys only (like the engine's applyOverrides)", () => {
    expect(effectiveActions(defaults, { jump: ["KeyK"] })[0]).toEqual({ ...defaults[0], keys: ["KeyK"] });
    expect(effectiveActions(defaults, { jump: [] })[0].keys).toEqual([]);
    expect(effectiveActions(defaults, { jump: [] })[0].gamepad).toEqual(["A"]);
    expect(effectiveActions(defaults, { nope: ["KeyK"] })).toEqual(defaults);
    expect(effectiveActions(defaults, { jump: ["Escape", "KeyK", "KeyK", "KeyA", "KeyB", "KeyC"] })[0].keys).toEqual(["KeyK", "KeyA", "KeyB"]);
    expect(effectiveActions(defaults, { jump: "KeyK" })).toEqual(defaults);
    expect(effectiveActions(defaults, null)).toEqual(defaults);
  });

  it("round-trips through localStorage with pruning", () => {
    expect(readOverrides("g1")).toEqual({});
    const stored = writeOverrides("g1", { jump: ["KeyK"], fire: ["KeyZ"], gone: ["KeyQ"] }, defaults);
    expect(stored).toEqual({ jump: ["KeyK"] }); // equal-to-default and undeclared ids are dropped
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({ v: 1, overrides: { jump: ["KeyK"] } });
    expect(readOverrides("g1")).toEqual({ jump: ["KeyK"] });
    // Resetting to the defaults removes the key.
    writeOverrides("g1", { jump: ["Space", "ArrowUp"] }, defaults);
    expect(localStorage.getItem(controlsStorageKey("g1"))).toBeNull();
    expect(readOverrides("g1")).toEqual({});
  });

  it("discards malformed, wrong-version and oversize entries", () => {
    const key = controlsStorageKey("g2");
    for (const bad of ["{not json", JSON.stringify({ v: 2, overrides: {} }), JSON.stringify({ v: 1, overrides: [] }), JSON.stringify([1])]) {
      localStorage.setItem(key, bad);
      expect(readOverrides("g2")).toEqual({});
      expect(localStorage.getItem(key)).toBeNull();
    }
    localStorage.setItem(key, JSON.stringify({ v: 1, overrides: { jump: ["KeyK"] }, pad: "x".repeat(8200) }));
    expect(readOverrides("g2")).toEqual({});
    expect(localStorage.getItem(key)).toBeNull();
    // Invalid codes and ids inside a valid entry are dropped.
    localStorage.setItem(key, JSON.stringify({ v: 1, overrides: { jump: ["KeyK", "Escape", 3], BAD: ["KeyA"], fire: "KeyZ" } }));
    expect(readOverrides("g2")).toEqual({ jump: ["KeyK"] });
  });

  it("an id like __proto__ can't touch the prototype", () => {
    const o = readOverridesFrom('{"v":1,"overrides":{"__proto__":["KeyA"]}}');
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.keys(o)).toEqual(["__proto__"]);
  });

  it("falls back to memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    writeOverrides("g3", { jump: ["KeyK"] }, defaults);
    expect(readOverrides("g3")).toEqual({ jump: ["KeyK"] });
  });

  it("notifies subscribers and other tabs' storage events", () => {
    const fn = vi.fn();
    const off = subscribeOverrides("g4", fn);
    writeOverrides("g4", { jump: ["KeyK"] }, defaults);
    expect(fn).toHaveBeenLastCalledWith({ jump: ["KeyK"] });
    localStorage.setItem(controlsStorageKey("g4"), JSON.stringify({ v: 1, overrides: { fire: ["KeyX"] } }));
    window.dispatchEvent(new StorageEvent("storage", { key: controlsStorageKey("g4") }));
    expect(fn).toHaveBeenLastCalledWith({ fire: ["KeyX"] });
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    writeOverrides("g4", {}, defaults);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("controlsMessage carries only declared ids, codes and button names, and always has gamepad", () => {
    expect(controlsMessage(defaults, { keys: { jump: ["KeyK"], gone: ["KeyQ"], fire: ["KeyZ"] }, gamepad: {} })).toEqual({
      type: "webgame:controls",
      overrides: { jump: ["KeyK"] },
      gamepad: {},
    });
    expect(controlsMessage(defaults, { keys: {}, gamepad: { jump: ["B", "Home" as never], fire: [], gone: ["A"] } })).toEqual({
      type: "webgame:controls",
      overrides: {},
      gamepad: { jump: ["B"] }, // fire has no default buttons, so its [] equals the defaults and is pruned
    });
    expect(controlsMessage(defaults, { keys: {}, gamepad: { jump: ["A"] } }).gamepad).toEqual({});
    expect(controlsMessage(defaults, null as never)).toEqual({ type: "webgame:controls", overrides: {}, gamepad: {} });
  });

  it("the first-play hint is taken once per game", () => {
    expect(takeControlsHint("g5")).toBe(true);
    expect(takeControlsHint("g5")).toBe(false);
    expect(takeControlsHint("g6")).toBe(true);
    expect(localStorage.getItem("webgame.controls.hinted.g5")).toBe("1");
  });
});

function readOverridesFrom(raw: string) {
  localStorage.setItem(controlsStorageKey("gp"), raw);
  return readOverrides("gp");
}

describe("gamepad bindings (F016)", () => {
  const defaults = [act("jump", ["Space", "ArrowUp"], ["A"]), act("fire", ["KeyZ"]), act("menu", [], ["Start", "Up"])];

  it("sanitizeGamepadOverrides keeps valid ids, arrays, table names, unique, ≤ 2, ≤ 32 ids", () => {
    expect(sanitizeGamepadOverrides({ jump: ["B", "B", "Home", "Triangle", 3, "X", "Y"], BAD: ["A"], fire: "A", menu: [] })).toEqual({
      jump: ["B", "X"],
      menu: [],
    });
    expect(sanitizeGamepadOverrides([["A"]])).toEqual({});
    expect(sanitizeGamepadOverrides(null)).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${i}`, ["A"]]));
    expect(Object.keys(sanitizeGamepadOverrides(many))).toHaveLength(32);
    const proto = sanitizeGamepadOverrides(JSON.parse('{"__proto__":["A"]}'));
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });

  it("sanitizeBindings handles missing, null and bad parts", () => {
    expect(sanitizeBindings(null)).toEqual({ keys: {}, gamepad: {} });
    expect(sanitizeBindings({ keys: null, gamepad: [] })).toEqual({ keys: {}, gamepad: {} });
    expect(sanitizeBindings({ keys: { jump: ["KeyK", "Escape"] }, gamepad: { jump: ["B"] }, extra: 1 })).toEqual({ keys: { jump: ["KeyK"] }, gamepad: { jump: ["B"] } });
  });

  it("effectiveActions applies gamepad overrides like the engine", () => {
    expect(effectiveActions(defaults, {}, { jump: ["B"] })[0]).toEqual({ ...defaults[0], gamepad: ["B"] });
    expect(effectiveActions(defaults, {}, { jump: [] })[0].gamepad).toEqual([]);
    expect(effectiveActions(defaults, {}, { jump: [] })[0].keys).toEqual(["Space", "ArrowUp"]);
    expect(effectiveActions(defaults, {}, { jump: ["Home", "X", "X", "Y", "B"] })[0].gamepad).toEqual(["X", "Y"]);
    expect(effectiveActions(defaults, {}, { nope: ["B"], jump: "B" })).toEqual(defaults);
    expect(effectiveActions(defaults, { jump: ["KeyK"] }, { jump: ["B"] })[0]).toMatchObject({ keys: ["KeyK"], gamepad: ["B"] });
    expect(effectiveActions(defaults, { jump: ["KeyK"] })[0].gamepad).toEqual(["A"]);
  });

  it("pruneBindings drops undeclared ids and entries equal to the defaults, keys and gamepad separately", () => {
    expect(
      pruneBindings(
        { keys: { gone: ["KeyQ"], jump: ["Space", "ArrowUp"], fire: ["KeyX"] }, gamepad: { menu: ["Start", "Up"], jump: ["B"], gone: ["A"], fire: ["X"] } },
        defaults,
      ),
    ).toEqual({ keys: { fire: ["KeyX"] }, gamepad: { jump: ["B"], fire: ["X"] } });
    // Manifest order.
    expect(Object.keys(pruneBindings({ keys: {}, gamepad: { menu: ["A"], jump: ["B"] } }, defaults).gamepad)).toEqual(["jump", "menu"]);
    // Same buttons in another order differ from the defaults.
    expect(pruneBindings({ keys: {}, gamepad: { menu: ["Up", "Start"] } }, defaults).gamepad).toEqual({ menu: ["Up", "Start"] });
  });

  it("isActionChanged covers keys and gamepad buttons", () => {
    expect(isActionChanged(defaults[0], {}, { jump: ["B"] })).toBe(true);
    expect(isActionChanged(defaults[0], {}, { jump: ["A"] })).toBe(false);
    expect(isActionChanged(defaults[0], { jump: ["KeyK"] }, {})).toBe(true);
    expect(isActionChanged(defaults[0], {}, {})).toBe(false);
    expect(isActionChanged(defaults[0], {})).toBe(false);
  });

  it("round-trips bindings and the unsynced marker through the store", () => {
    const stored = writeBindings("g1", { keys: { jump: ["KeyK"] }, gamepad: { jump: ["B"], gone: ["A"] } }, defaults, { unsynced: "u1" });
    expect(stored).toEqual({ keys: { jump: ["KeyK"] }, gamepad: { jump: ["B"] } });
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({
      v: 1,
      overrides: { jump: ["KeyK"] },
      gamepad: { jump: ["B"] },
      unsynced: "u1",
    });
    expect(readBindings("g1")).toEqual(stored);
    expect(readUnsynced("g1")).toBe("u1");
    // Absent opts keep the marker; null clears it.
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, defaults);
    expect(readUnsynced("g1")).toBe("u1");
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, defaults, { unsynced: null });
    expect(readUnsynced("g1")).toBeNull();
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({ v: 1, overrides: {}, gamepad: { jump: ["X"] } });
  });

  it("an empty entry is kept while unsynced, and removed once synced", () => {
    writeBindings("g1", { keys: {}, gamepad: {} }, defaults, { unsynced: "u1" });
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({ v: 1, overrides: {}, unsynced: "u1" });
    writeBindings("g1", { keys: {}, gamepad: {} }, defaults, { unsynced: null });
    expect(localStorage.getItem(controlsStorageKey("g1"))).toBeNull();
  });

  it("reads an F009 entry (no gamepad) with empty gamepad, and tolerates bad gamepad / unsynced values", () => {
    const key = controlsStorageKey("g2");
    localStorage.setItem(key, JSON.stringify({ v: 1, overrides: { jump: ["KeyK"] } }));
    expect(readBindings("g2")).toEqual({ keys: { jump: ["KeyK"] }, gamepad: {} });
    expect(readUnsynced("g2")).toBeNull();
    localStorage.setItem(key, JSON.stringify({ v: 1, overrides: { jump: ["KeyK"] }, gamepad: ["A"], unsynced: "" }));
    expect(readBindings("g2")).toEqual({ keys: { jump: ["KeyK"] }, gamepad: {} });
    expect(readUnsynced("g2")).toBeNull();
    localStorage.setItem(key, JSON.stringify({ v: 1, overrides: {}, gamepad: { jump: ["B", "Home"] }, unsynced: 7 }));
    expect(readBindings("g2")).toEqual({ keys: {}, gamepad: { jump: ["B"] } });
    expect(readUnsynced("g2")).toBeNull();
    // A non-object overrides still discards the whole entry (F009 rule).
    localStorage.setItem(key, JSON.stringify({ v: 1, gamepad: { jump: ["B"] } }));
    expect(readBindings("g2")).toEqual({ keys: {}, gamepad: {} });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("a keys-only write keeps the stored gamepad (and the marker)", () => {
    writeBindings("g3", { keys: {}, gamepad: { jump: ["B"] } }, defaults, { unsynced: "u1" });
    writeOverrides("g3", { fire: ["KeyX"] }, defaults);
    expect(readBindings("g3")).toEqual({ keys: { fire: ["KeyX"] }, gamepad: { jump: ["B"] } });
    expect(readUnsynced("g3")).toBe("u1");
    expect(readOverrides("g3")).toEqual({ fire: ["KeyX"] });
  });

  it("caps the serialised entry at 8192 bytes", () => {
    expect(CONTROLS_OVERRIDES_MAX_BYTES).toBe(8192);
    const key = controlsStorageKey("g4");
    const under = JSON.stringify({ v: 1, overrides: { jump: ["KeyK"] }, pad: "" });
    const fill = (n: number) => JSON.stringify({ v: 1, overrides: { jump: ["KeyK"] }, pad: "x".repeat(n - under.length) });
    localStorage.setItem(key, fill(8192));
    expect(new TextEncoder().encode(localStorage.getItem(key)!).length).toBe(8192);
    expect(readBindings("g4").keys).toEqual({ jump: ["KeyK"] });
    localStorage.setItem(key, fill(8193));
    expect(readBindings("g4").keys).toEqual({});
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("subscribers get the bindings when they change, not on marker-only writes", () => {
    const fn = vi.fn();
    const keysFn = vi.fn();
    const off = subscribeBindings("g5", fn);
    const offKeys = subscribeOverrides("g5", keysFn);
    writeBindings("g5", { keys: {}, gamepad: { jump: ["B"] } }, defaults, { unsynced: "u1" });
    expect(fn).toHaveBeenLastCalledWith({ keys: {}, gamepad: { jump: ["B"] } });
    expect(keysFn).toHaveBeenLastCalledWith({});
    writeBindings("g5", { keys: {}, gamepad: { jump: ["B"] } }, defaults, { unsynced: null });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    offKeys();
  });
});

describe("findConflicts and the Ctrl warning", () => {
  it("reports other actions sharing a key", () => {
    const list = [act("a", ["KeyA", "Space"]), act("b", ["Space"]), act("c", ["KeyC"]), act("d", ["KeyA"])];
    expect(findConflicts(list)).toEqual({ a: ["b", "d"], b: ["a"], d: ["a"] });
    expect(findConflicts([act("a", ["KeyA"]), act("b", [], ["A"])])).toEqual({});
  });

  it("covers gamepad buttons in one combined list (manifest order, no duplicates)", () => {
    const list = [act("a", ["Space"], ["A"]), act("b", ["KeyB"], ["A", "B"]), act("c", ["Space"], ["B"]), act("d", ["KeyD"], ["X"])];
    expect(findConflicts(list)).toEqual({ a: ["b", "c"], b: ["a", "c"], c: ["a", "b"] });
    expect(findConflicts([act("a", [], ["Start"]), act("b", [], ["Start"])])).toEqual({ a: ["b"], b: ["a"] });
  });

  it("warns about Ctrl+W/T/N", () => {
    expect(hasCtrlShortcutRisk([act("a", ["ControlLeft"]), act("b", ["KeyW"])])).toBe(true);
    expect(hasCtrlShortcutRisk([act("a", ["ControlRight", "KeyN"])])).toBe(true);
    expect(hasCtrlShortcutRisk([act("a", ["ControlLeft"]), act("b", ["KeyQ"])])).toBe(false);
    expect(hasCtrlShortcutRisk([act("a", ["KeyW"])])).toBe(false);
  });
});
