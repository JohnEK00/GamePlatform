import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { resetControlsStoreForTests } from "../controls";
import type { StudioProject } from "../studio/project";
import { StudioPreview } from "../studio/StudioPreview";
import { WebGameProviders } from "../WebGameApp";
import { installFakeGamepads, type FakeGamepads } from "./fakeGamepads";

const API = "http://api.test";

let pads: FakeGamepads;
beforeEach(() => {
  pads = installFakeGamepads();
});
afterEach(() => {
  pads.uninstall();
  vi.restoreAllMocks();
  resetControlsStoreForTests();
});

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

const project: StudioProject = {
  manifest: { name: "Draft", entry: "main.js", width: 320, height: 240, actions: [{ id: "jump", name: "Jump", keys: ["Space"], gamepad: ["A"] }] },
  files: { "main.js": "export default {}" },
};

describe("StudioPreview gamepad bindings (F016)", () => {
  it("captures gamepad buttons, posts them with webgame:controls and keeps them in memory only", () => {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: API });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const putControls = vi.spyOn(client, "putControls");
    const getControls = vi.spyOn(client, "getControls");
    const ui = (runId: number) => (
      <WebGameProviders config={{ apiBaseUrl: API, routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <StudioPreview project={project} runId={runId} onLog={() => {}} />
        </MemoryRouter>
      </WebGameProviders>
    );
    const utils = render(ui(1));
    const win = () => utils.container.querySelector("iframe")!.contentWindow!;
    let spy = vi.spyOn(win(), "postMessage");
    const controls = () => spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === "webgame:controls");

    pads.connect(0);
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Controls" });
    expect(within(dialog).getByText("Kept for this Studio session")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Jump, gamepad button 1: / }));
    pads.press(0, 1);
    pads.frame();
    expect(controls().at(-1)).toEqual({ type: "webgame:controls", overrides: {}, gamepad: { jump: ["B"] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    expect(Object.keys(localStorage).filter((k) => k.startsWith("webgame.controls"))).toEqual([]);
    expect(putControls).not.toHaveBeenCalled();
    expect(getControls).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/controls"))).toEqual([]);

    // A new run gets the in-memory bindings after its load reply.
    utils.rerender(ui(2));
    spy = vi.spyOn(win(), "postMessage");
    post(win(), { type: "webgame:hello" });
    expect(controls()).toEqual([{ type: "webgame:controls", overrides: {}, gamepad: { jump: ["B"] } }]);
  });
});
