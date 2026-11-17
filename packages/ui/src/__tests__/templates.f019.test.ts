import { describe, expect, it } from "vitest";
import { normalizeActions, validateActions } from "../controls";
import { validateProject } from "../studio/project";
import { STUDIO_TEMPLATES } from "../studio/templates";

describe("Menu & HUD template settings screen (F019)", () => {
  const t = STUDIO_TEMPLATES.find((x) => x.id === "menu-hud")!;
  const js = t.files["main.js"] as string;

  it("uses all four F019 widgets and the change signals", () => {
    expect(js).toMatch(/ui\.slider\(/);
    expect(js).toMatch(/ui\.toggle\(/);
    expect(js).toMatch(/ui\.textField\(/);
    expect(js).toMatch(/ui\.list\(/);
    expect(js).toMatch(/ui\.committed\(/);
    expect(js).toMatch(/ui\.changed\(/);
  });

  it("wires each widget per the spec (value in, value out)", () => {
    // NAME: 12 code points, letters/digits/space/-/_ only, saved on commit.
    expect(js).toMatch(/this\.name = ui\.textField\("name", this\.name, /);
    expect(js).toMatch(/const NAME_MAX = 12;/);
    expect(js).toContain("/^[A-Za-z0-9 _-]$/");
    expect(js).toMatch(/if \(ui\.committed\("name"\)\)/);
    expect(js).toMatch(/storage\.set\("name", /);
    // VOLUME: 0..1 in steps of 0.1, a percentage label, saved on commit only.
    expect(js).toMatch(/this\.volume = ui\.slider\("volume", this\.volume, [^)]*\{ min: 0, max: 1, step: 0\.1 \}\)/);
    expect(js).toMatch(/Math\.round\(this\.volume \* 100\) \+ "%"/);
    expect(js).toMatch(/audio\.masterVolume = /);
    expect(js).toMatch(/if \(ui\.committed\("volume"\)\) \{\s*storage\.set\("volume", /);
    // SOUND: a toggle driving engine.audio.muted.
    expect(js).toMatch(/this\.sound = ui\.toggle\("sound", this\.sound, "SOUND", /);
    expect(js).toMatch(/audio\.muted = !this\.sound/);
    // STAR COLOUR: 6 colours, 3 visible rows of 16, selected = current.
    expect(js).toMatch(/ui\.list\("colour", names, [^)]*48, \{ rowHeight: 16, selected: this\.colour \}\)/);
    expect(js.match(/\{ name: "[A-Z]+", color: "#[0-9a-f]{6}" \}/g)).toHaveLength(6);
    // BACK, plus the pause action (not while typing), with focus restored on the title menu.
    expect(js).toMatch(/ui\.button\("back", "BACK", [^)]*\)\) this\.go\(engine, "title", "settings"\)/);
    expect(js).toMatch(/inSettings && this\.state === "settings" && input\.actionPressed\("pause"\) && !engine\.ui\.editing/);
    expect(js).toMatch(/ui\.button\("settings", "SETTINGS", [^)]*\)\) this\.go\(engine, "settings", "name"\)/);
    // F023: the engine's on-screen keyboard replaces the old hint for touch and controller players.
    expect(js).not.toContain("Type your name with a keyboard");
    expect(js).toContain(
      "// Touch and controller players get the engine's on-screen keyboard when they start typing (F023).",
    );
    // The name shows on the HUD and the game-over screen.
    expect(js.match(/this\.scoreText\(\)/g)?.length).toBe(2);
  });

  it("no longer has the SOUND: ON/OFF button", () => {
    expect(js).not.toMatch(/"SOUND: "/);
  });

  it("still declares the menu actions and validates", () => {
    expect(validateActions(t.manifest)).toEqual([]);
    expect(normalizeActions(t.manifest.actions).map((a) => a.id)).toEqual(["left", "right", "up", "down", "confirm", "pause"]);
    expect(validateProject({ manifest: t.manifest, files: t.files })).toEqual([]);
  });

  it("parses as a module body", () => {
    expect(() => new Function(js.replace("export default", "return"))).not.toThrow();
  });

  it("documents the fullscreen Escape caveat next to the NAME field (review 8, L2)", () => {
    expect(js).toContain("the browser takes the");
    expect(js).toMatch(/press Escape again, or use gamepad B/);
  });

  // Review 8, M1: the key that starts typing on a focused NAME field may also report as the "pause" action, and
  // ui.editing is only set once the field's call has run. The guard must read it after menus().
  describe("pause guard on the settings screen", () => {
    type Game = { state: string; update(engine: unknown, dt: number): void };
    const makeGame = () => (new Function(js.replace("export default", "return")) as () => Game)();

    function fakeEngine(opts: { pause: boolean; startsTyping: boolean }) {
      const ui: Record<string, unknown> = {
        focus: "name" as string | null,
        editing: null as string | null,
        panel() {},
        label() {},
        button: () => false,
        slider: (_id: string, v: number) => v,
        toggle: (_id: string, v: boolean) => v,
        list: () => -1,
        changed: () => false,
        committed: () => false,
        textField(id: string, v: string) {
          if (opts.startsTyping) ui.editing = id;
          return v;
        },
      };
      return {
        width: 320,
        height: 240,
        ui,
        input: { actionPressed: (id: string) => opts.pause && id === "pause", lastDevice: "keyboard", actionLabel: () => "P" },
        audio: { tone() {}, masterVolume: 1, muted: false },
        storage: { get: (_k: string, d: unknown) => d, set() {} },
      };
    }

    it("stays on the settings when the typed key that starts editing is also the pause key", () => {
      const game = Object.assign(makeGame(), { state: "settings", sound: false, volume: 1, name: "", colour: 0, focusNext: null });
      const engine = fakeEngine({ pause: true, startsTyping: true });
      game.update(engine, 1 / 60);
      expect(engine.ui.editing).toBe("name");
      expect(game.state).toBe("settings");
    });

    it("still goes back to the title on pause when nothing is being typed", () => {
      const game = Object.assign(makeGame(), { state: "settings", sound: false, volume: 1, name: "", colour: 0, focusNext: null });
      const engine = fakeEngine({ pause: true, startsTyping: false });
      game.update(engine, 1 / 60);
      expect(game.state).toBe("title");
    });
  });
});
