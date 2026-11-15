import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { User } from "../api/types";
import { resetControlsStoreForTests } from "../controls";
import { StudioPage } from "../pages/StudioPage";
import { ControlsFieldset } from "../studio/ControlsFieldset";
import { serializeProject, STUDIO_STORAGE_KEY, type StudioManifest, type StudioProject } from "../studio/project";
import { StudioPreview } from "../studio/StudioPreview";
import { WebGameProviders } from "../WebGameApp";

const API = "http://api.test";
const me: User = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

afterEach(() => {
  vi.restoreAllMocks();
  resetControlsStoreForTests();
});

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function FormHarness({ initial, onManifest }: { initial: StudioManifest; onManifest: (m: StudioManifest) => void }) {
  const [m, setM] = useState<StudioManifest>(initial);
  return (
    <ControlsFieldset
      manifest={m}
      onChange={(n) => {
        onManifest(n);
        setM(n);
      }}
    />
  );
}

function renderForm(initial: StudioManifest = { name: "T", entry: "main.js", width: 320, height: 240 }) {
  let last: StudioManifest = initial;
  render(<FormHarness initial={initial} onManifest={(m) => (last = m)} />);
  return { manifest: () => last };
}

describe("Studio game.json Controls fieldset (F009)", () => {
  it("edits the controls hint with a live counter", () => {
    const { manifest } = renderForm();
    expect(screen.getByRole("group", { name: "Controls" })).toBeTruthy();
    const input = screen.getByRole("textbox", { name: /Controls hint/ });
    expect(screen.getByText("0/300")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Arrows move" } });
    expect(manifest().controls).toBe("Arrows move");
    expect(screen.getByText("11/300")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect("controls" in manifest()).toBe(false);
  });

  it("adds an action, captures keys, picks gamepad buttons, and shows errors until it is valid", () => {
    const { manifest } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "+ Add action" }));
    expect(manifest().actions).toEqual([{ id: "action1", name: "Action 1", keys: [], gamepad: [] }]);
    // No binding yet: inline error (mirrors the backend rule).
    expect(screen.getByText("action needs at least one key or gamepad button")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Fire" } });
    fireEvent.change(screen.getByRole("textbox", { name: "ID" }), { target: { value: "fire" } });
    const s1 = screen.getByRole("button", { name: /^Fire, key 1: / });
    fireEvent.click(s1);
    fireEvent.keyDown(s1, { code: "KeyZ", key: "z" });
    expect(manifest().actions).toEqual([{ id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] }]);
    expect(screen.queryByText(/needs at least one key/)).toBeNull();
    // Escape can't be captured: it cancels.
    const s2 = screen.getByRole("button", { name: /^Fire, key 2: / });
    fireEvent.click(s2);
    fireEvent.keyDown(s2, { code: "Escape", key: "Escape" });
    expect((manifest().actions as { keys: string[] }[])[0].keys).toEqual(["KeyZ"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Gamepad button 1 for Fire" }), { target: { value: "RT" } });
    expect((manifest().actions as { gamepad: string[] }[])[0].gamepad).toEqual(["RT"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear Z from Fire" }));
    expect((manifest().actions as { keys: string[] }[])[0].keys).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Remove action Fire" }));
    expect("actions" in manifest()).toBe(false);
  });

  it("+ Add movement adds left/right/up/down with Arrows + WASD and the D-pad, skipping existing ids", () => {
    const { manifest } = renderForm({ name: "T", actions: [{ id: "left", name: "Go left", keys: ["KeyJ"] }] });
    fireEvent.click(screen.getByRole("button", { name: "+ Add movement" }));
    expect(manifest().actions).toEqual([
      { id: "left", name: "Go left", keys: ["KeyJ"] },
      { id: "right", name: "Move right", keys: ["ArrowRight", "KeyD"], gamepad: ["Right"] },
      { id: "up", name: "Move up", keys: ["ArrowUp", "KeyW"], gamepad: ["Up"] },
      { id: "down", name: "Move down", keys: ["ArrowDown", "KeyS"], gamepad: ["Down"] },
    ]);
    expect((screen.getByRole("button", { name: "+ Add movement" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("flags hand-written invalid entries inline", () => {
    renderForm({
      name: "T",
      actions: [
        { id: "jump", name: "Jump", keys: ["Escape"], gamepad: ["Home"] },
        { id: "jump", name: "", keys: ["Space"] },
      ],
    });
    expect(screen.getByText('keys[0] "Escape" can\'t be bound')).toBeTruthy();
    expect(screen.getByText('gamepad[0] "Home" is not a gamepad button')).toBeTruthy();
    expect(screen.getByText('id "jump" is a duplicate')).toBeTruthy();
    expect(screen.getByText("name must be 1–40 characters")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Jump, key 1: Escape/ }).getAttribute("aria-invalid")).toBe("true");
  });

  it("explains a non-array actions value", () => {
    renderForm({ name: "T", actions: "jump" as unknown as [] });
    expect(screen.getByRole("alert").textContent).toMatch(/game\.json: actions must be an array/);
  });
});

function setupStudio(project: StudioProject) {
  const client = new ApiClient({ baseUrl: API, fetch: vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch });
  localStorage.setItem("webgame.token", "tok");
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listGames").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const create = vi.spyOn(client, "createGame");
  localStorage.setItem(STUDIO_STORAGE_KEY, serializeProject(project, { link: null, dirty: false }));
  render(
    <WebGameProviders config={{ apiBaseUrl: API, routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/studio"]}>
        <StudioPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { create };
}

describe("Studio publish gate (F009)", () => {
  const files = { "main.js": "export default {}" };
  const base = { name: "Space Dodge", entry: "main.js", width: 320, height: 240 };

  it("blocks publish while game.json actions have errors", async () => {
    const { create } = setupStudio({ manifest: { ...base, actions: [{ id: "fire", name: "Fire", keys: ["Escape"] }] }, files });
    const publish = await screen.findByRole("button", { name: /⬆ Publish/ });
    await act(async () => fireEvent.click(publish));
    const dialog = screen.getByRole("dialog", { name: "Publish" });
    expect(within(dialog).getByText("Fix the errors in game.json → Controls first")).toBeTruthy();
    const btn = within(dialog).getByRole("button", { name: /^Publish$/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => fireEvent.submit(btn.closest("form")!));
    expect(create).not.toHaveBeenCalled();
  });

  it("allows publish with valid actions and shows the fieldset in the game.json form", async () => {
    setupStudio({ manifest: { ...base, actions: [{ id: "fire", name: "Fire", keys: ["Space"] }] }, files });
    const publish = await screen.findByRole("button", { name: /⬆ Publish/ });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /game\.json/ })));
    expect(screen.getByRole("group", { name: "Controls" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Fire, key 1: Space/ })).toBeTruthy();
    await act(async () => fireEvent.click(publish));
    const dialog = screen.getByRole("dialog", { name: "Publish" });
    expect(within(dialog).queryByText("Fix the errors in game.json → Controls first")).toBeNull();
    expect((within(dialog).getByRole("button", { name: /^Publish$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("StudioPreview controls (F009)", () => {
  const project: StudioProject = {
    manifest: {
      name: "Draft",
      entry: "main.js",
      width: 320,
      height: 240,
      controls: "Mouse\nto aim",
      actions: [
        { id: "jump", name: "Jump", keys: ["Space"], gamepad: ["A"] },
        { id: "bad", name: "Bad", keys: ["Escape"] }, // dropped leniently, like the engine
      ],
    },
    files: { "main.js": "export default {}" },
  };

  function setupPreview(p: StudioProject = project) {
    const client = new ApiClient({ baseUrl: API });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ui = (runId: number) => (
      <WebGameProviders config={{ apiBaseUrl: API, routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <StudioPreview project={p} runId={runId} onLog={() => {}} />
        </MemoryRouter>
      </WebGameProviders>
    );
    const utils = render(ui(1));
    const win = () => utils.container.querySelector("iframe")!.contentWindow!;
    return { ...utils, win, fetchSpy, rerun: (id: number) => utils.rerender(ui(id)) };
  }

  const sent = (spy: { mock: { calls: unknown[][] } }, type: string) => spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === type);

  it("posts webgame:controls after the load reply and after a change, with in-memory overrides only", () => {
    const { win, rerun, fetchSpy } = setupPreview();
    let spy = vi.spyOn(win(), "postMessage");
    post(win(), { type: "webgame:hello" });
    expect(spy.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["webgame:load", "webgame:controls"]);
    expect(sent(spy, "webgame:controls")[0]).toEqual({ type: "webgame:controls", overrides: {} });

    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    expect(sent(spy, "webgame:pause")).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "Controls" });
    expect(within(dialog).getByText("Mouse to aim")).toBeTruthy();
    expect(within(dialog).getByText("Kept for this Studio session")).toBeTruthy();
    expect(within(dialog).queryByText("Bad")).toBeNull();
    const s = within(dialog).getByRole("button", { name: /^Jump, key 2: / });
    fireEvent.click(s);
    fireEvent.keyDown(s, { code: "KeyK", key: "k" });
    expect(sent(spy, "webgame:controls").at(-1)).toEqual({ type: "webgame:controls", overrides: { jump: ["Space", "KeyK"] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(sent(spy, "webgame:resume")).toHaveLength(1);

    // Never localStorage, never the API.
    expect(Object.keys(localStorage).filter((k) => k.startsWith("webgame.controls"))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // A new run keeps the session's overrides.
    rerun(2);
    spy = vi.spyOn(win(), "postMessage");
    post(win(), { type: "webgame:hello" });
    expect(sent(spy, "webgame:controls")).toEqual([{ type: "webgame:controls", overrides: { jump: ["Space", "KeyK"] } }]);
  });

  it("has no ⌨ button and posts no controls for a project without actions or hint", () => {
    const { win } = setupPreview({ manifest: { name: "x", entry: "main.js", width: 320, height: 240 }, files: { "main.js": "" } });
    const spy = vi.spyOn(win(), "postMessage");
    post(win(), { type: "webgame:hello" });
    expect(sent(spy, "webgame:controls")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Controls" })).toBeNull();
  });
});
