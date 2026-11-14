import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { GameAchievement, Leaderboard as LeaderboardData, User, UserAchievement } from "../api/types";
import { ConfirmDialog } from "../components/common";
import { GameAchievements, RecentAchievements } from "../components/Achievements";
import { Leaderboard } from "../components/Leaderboard";
import { ReportDialog } from "../components/Report";
import { CodeEditor } from "../studio/CodeEditor";
import { StudioPreview, type StudioConsoleEntry } from "../studio/StudioPreview";
import { serializeProject, STUDIO_STORAGE_KEY, type StudioProject } from "../studio/project";
import { WebGameApp, WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function providers(client: ApiClient, children: React.ReactNode) {
  return (
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </WebGameProviders>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

// ---------------------------------------------------------------------------------------------
// R3: multi-file projects in the Studio preview

const multi: StudioProject = {
  manifest: { name: "Multi", entry: "main.js", width: 320, height: 240 },
  files: {
    "main.js": 'import { Player } from "./lib/player.js";\nexport default { load() { new Player(); } };\n',
    "lib/player.js": "export class Player {\n  constructor() {\n    this.x = undefinedThing;\n  }\n}\n",
    "lib/util.js": "export const k = 1;\n",
    "assets/a.png": new Uint8Array([1, 2, 3]).buffer,
  },
};

async function renderStudio(project: StudioProject = multi) {
  localStorage.setItem(STUDIO_STORAGE_KEY, serializeProject(project));
  window.location.hash = "#/studio";
  const client = new ApiClient({ baseUrl: "" });
  render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={client} />);
  await screen.findByRole("heading", { name: "Studio" });
  const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Game preview"]')!;
  return { iframe, client };
}

describe("R3: Studio multi-file modules", () => {
  it("StudioPreview sends every .js file (and assets) in studio-load", () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const logs: StudioConsoleEntry[] = [];
    const { container } = render(providers(client, <StudioPreview project={multi} runId={1} onLog={(e) => logs.push(e)} />));
    const w = container.querySelector("iframe")!.contentWindow!;
    const spy = vi.spyOn(w, "postMessage");
    post(w, { type: "webgame:studio-ready" });
    const msg = spy.mock.calls.map((c) => c[0] as { type: string; files: Record<string, unknown> }).find((m) => m.type === "webgame:studio-load")!;
    expect(Object.keys(msg.files).sort()).toEqual(["assets/a.png", "lib/player.js", "lib/util.js", "main.js"]);
    expect(msg.files["lib/player.js"]).toBe(multi.files["lib/player.js"]);
  });

  it("attributes errors to their file and click-to-jump opens that file at the line", async () => {
    const { iframe } = await renderStudio();
    post(iframe.contentWindow, { type: "webgame:error", message: "ReferenceError: undefinedThing is not defined", file: "lib/player.js", line: 3, column: 14 });
    const loc = await screen.findByRole("button", { name: "Go to lib/player.js line 3, column 14" });
    expect(loc.textContent).toBe("lib/player.js:3:14");
    fireEvent.click(loc);
    const editor = await screen.findByRole("textbox", { name: "Edit lib/player.js" });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const ta = editor as HTMLTextAreaElement;
    const before = ta.value.split("\n").slice(0, 2).join("\n").length + 1;
    expect(ta.selectionStart).toBe(before + 13);
  });

  it("falls back to the entry file when the error has no (known) file", async () => {
    const { iframe } = await renderStudio();
    post(iframe.contentWindow, { type: "webgame:error", message: "boom", line: 2 });
    post(iframe.contentWindow, { type: "webgame:error", message: "boom2", file: "blob:http://x/123", line: 1 });
    expect(await screen.findByRole("button", { name: "Go to main.js line 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to main.js line 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to main.js line 2" }));
    expect(await screen.findByRole("textbox", { name: "Edit main.js" })).toBeTruthy();
  });

  it("shows the project size in the Studio bar", async () => {
    await renderStudio();
    expect(screen.getByTestId("studio-size").textContent).toMatch(/B · 5 files$/);
  });
});

// ---------------------------------------------------------------------------------------------
// R4: the code editor is not a keyboard trap

function Editor() {
  const [v, setV] = useState("let a = 1;");
  return <CodeEditor label="Edit main.js" value={v} onChange={setV} />;
}

describe("R4: CodeEditor keyboard access", () => {
  const tab = (el: Element, shiftKey = false) => fireEvent.keyDown(el, { key: "Tab", shiftKey }); // false = default prevented

  it("Tab indents while captured; Esc then Tab releases it once", () => {
    render(<Editor />);
    const ta = screen.getByRole("textbox", { name: "Edit main.js" }) as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
    expect(tab(ta)).toBe(false);
    expect(ta.value).toBe("  let a = 1;");

    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.getByText(/Press/).textContent).toMatch(/Press Tab to leave the editor/);
    expect(tab(ta)).toBe(true); // browser moves focus
    expect(ta.value).toBe("  let a = 1;");
    // one-shot: capture is back for the next Tab
    expect(tab(ta)).toBe(false);

    // Esc followed by another key also restores capture.
    fireEvent.keyDown(ta, { key: "Escape" });
    fireEvent.keyDown(ta, { key: "a" });
    expect(tab(ta)).toBe(false);
  });

  it("Ctrl+M toggles 'Tab moves focus' until toggled back", () => {
    render(<Editor />);
    const ta = screen.getByRole("textbox", { name: "Edit main.js" });
    fireEvent.keyDown(ta, { key: "m", ctrlKey: true });
    expect(tab(ta)).toBe(true);
    expect(tab(ta, true)).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Tab moves focus/);
    fireEvent.keyDown(ta, { key: "m", ctrlKey: true });
    expect(tab(ta)).toBe(false);
  });

  it("describes the shortcut with a visible hint", () => {
    render(<Editor />);
    const ta = screen.getByRole("textbox", { name: "Edit main.js" });
    const hint = document.getElementById(ta.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toMatch(/Esc then Tab to leave editor/);
  });
});

// ---------------------------------------------------------------------------------------------
// R9: accessible dialogs

function ConfirmHarness({ onCancel = () => {} }: { onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Behind</button>
      <ConfirmDialog
        open={open}
        title="Delete it?"
        confirmLabel="Delete"
        onConfirm={() => setOpen(false)}
        onCancel={() => {
          onCancel();
          setOpen(false);
        }}
      >
        Gone forever.
      </ConfirmDialog>
    </>
  );
}

describe("R9: dialogs", () => {
  it("ConfirmDialog: labelled, initial focus, Tab trap, Escape closes, focus restored", () => {
    const onCancel = vi.fn();
    render(<ConfirmHarness onCancel={onCancel} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete it?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: /Delete/ });
    expect(document.activeElement).toBe(cancel);

    // Tab wraps around inside the dialog, both ways.
    confirm.focus();
    expect(fireEvent.keyDown(confirm, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(confirm);
    // Tab between inner elements is left to the browser.
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true);

    // Focus that escapes is pulled back.
    act(() => screen.getByRole("button", { name: "Behind" }).focus());
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("ReportDialog: focuses the selected reason, traps Tab, Escape closes and restores focus", () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Report
          </button>
          <ReportDialog open={open} targetType="game" targetId="g1" targetLabel="Space" onClose={() => setOpen(false)} />
        </>
      );
    }
    render(providers(client, <Harness />));
    const opener = screen.getByRole("button", { name: "Report" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toMatch(/Report game/);
    const spam = screen.getByRole("radio", { name: /Spam/ });
    expect(document.activeElement).toBe(spam);
    // Shift+Tab from the first stop wraps to the last button.
    expect(fireEvent.keyDown(spam, { key: "Tab", shiftKey: true })).toBe(false);
    const buttons = dialog.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Studio Publish dialog: initial focus on the title, Escape closes, focus back on Publish", async () => {
    localStorage.setItem("webgame.token", "tok");
    localStorage.setItem(STUDIO_STORAGE_KEY, serializeProject({ manifest: multi.manifest, files: { "main.js": "export default {}" } }));
    window.location.hash = "#/studio";
    const client = new ApiClient({ baseUrl: "" });
    vi.spyOn(client, "me").mockResolvedValue(me);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={client} />);
    const publish = await screen.findByRole("button", { name: /Publish/ });
    publish.focus();
    fireEvent.click(publish);
    const dialog = screen.getByRole("dialog", { name: "Publish to the arcade" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.id).toBe("pf-game-title");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(publish);
  });
});

// ---------------------------------------------------------------------------------------------
// R15: recoverable load failures

describe("R15: retry on load failures", () => {
  it("Leaderboard shows an error with Retry, and Retry reloads", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const ok: LeaderboardData = {
      period: "week",
      periodStart: null,
      periodEnd: null,
      config: { order: "desc", format: "number", label: "" },
      entries: [{ id: "s1", user: { id: "u2", username: "amy", displayName: "Amy", avatarUrl: null }, score: 42, createdAt: "2026-11-14T00:00:00Z", rank: 1 }],
      totalPlayers: 1,
      me: null,
    };
    const get = vi.spyOn(client, "getLeaderboard").mockRejectedValueOnce(new ApiError("network", "down", 0)).mockResolvedValue(ok);
    render(providers(client, <Leaderboard gameId="g1" />));
    expect(await screen.findByText("Couldn't load scores.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Amy")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("GameAchievements shows an error with Retry instead of disappearing", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const ach = { id: "win", name: "Winner", description: "", iconUrl: null, unlockedAt: null, unlockedBy: 3 } as unknown as GameAchievement;
    const list = vi.spyOn(client, "listGameAchievements").mockRejectedValueOnce(new ApiError("internal", "oops", 500)).mockResolvedValue([ach]);
    render(providers(client, <GameAchievements gameId="g1" />));
    expect(await screen.findByText("Couldn't load achievements.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Achievements" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Winner")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("RecentAchievements shows an error with Retry; still renders nothing when empty", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const ua = { id: "win", name: "Winner", description: "", iconUrl: null, gameId: "g1", gameTitle: "Space", unlockedAt: "2026-11-14T00:00:00Z" } as UserAchievement;
    vi.spyOn(client, "listUserAchievements").mockRejectedValueOnce(new ApiError("network", "down", 0)).mockResolvedValueOnce([ua]).mockResolvedValue([]);
    const { unmount } = render(providers(client, <RecentAchievements username="bob" />));
    expect(await screen.findByText("Couldn't load achievements.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Winner")).toBeTruthy();
    unmount();
    const { container } = render(providers(client, <RecentAchievements username="bob" />));
    await waitFor(() => expect(container.querySelector(".pf-skeleton")).toBeNull());
    expect(screen.queryByText("Recent achievements")).toBeNull();
  });
});
