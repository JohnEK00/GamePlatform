import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Score } from "../api/types";
import { GamePlayer } from "../components/GamePlayer";
import { WebGameProviders } from "../WebGameApp";

const game = { id: "g1", title: "Space Dodge", width: 800, height: 600, playUrl: "/play/g1", version: 3, published: true, isOwner: false };

function setup() {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const recordPlay = vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 42 });
  const submitScore = vi.spyOn(client, "submitScore");
  const onPlayRecorded = vi.fn();
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={game} onPlayRecorded={onPlayRecorded} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  const iframe = utils.container.querySelector("iframe")!;
  return { ...utils, client, iframe, recordPlay, submitScore, onPlayRecorded };
}

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

describe("GamePlayer", () => {
  it("renders a sandboxed iframe without allow-same-origin", () => {
    const { iframe } = setup();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-pointer-lock");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("allow")).toBe("fullscreen; gamepad; autoplay");
    expect(iframe.getAttribute("src")).toBe("http://api.test/play/g1?v=3");
  });

  it("ignores webgame messages from other sources", async () => {
    const { recordPlay, submitScore } = setup();
    // A different frame posing as the game.
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(other.contentWindow, { type: "webgame:ready" });
    post(window, { type: "webgame:ready" });
    post(null, { type: "webgame:score", score: 999 });
    post(other.contentWindow, { type: "webgame:score", score: 999 });
    await new Promise((r) => setTimeout(r, 10));
    expect(recordPlay).not.toHaveBeenCalled();
    expect(submitScore).not.toHaveBeenCalled();
    expect(screen.queryByText(/You scored/)).toBeNull();
    other.remove();
  });

  it("records a play once when the game frame reports ready", async () => {
    const { iframe, recordPlay, onPlayRecorded } = setup();
    post(iframe.contentWindow, { type: "webgame:ready" });
    post(iframe.contentWindow, { type: "webgame:ready" });
    await waitFor(() => expect(onPlayRecorded).toHaveBeenCalledWith(42));
    expect(recordPlay).toHaveBeenCalledTimes(1);
    expect(recordPlay).toHaveBeenCalledWith("g1");
  });

  it("prompts to log in when a logged-out player scores", async () => {
    const { iframe, submitScore } = setup();
    post(iframe.contentWindow, { type: "webgame:score", score: 1234.4 });
    expect(await screen.findByText(/You scored 1,234!/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
    expect(submitScore).not.toHaveBeenCalled();
  });

  it("submits scores from the game frame when logged in", async () => {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "" });
    vi.spyOn(client, "me").mockResolvedValue({ id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z" });
    const saved: Score = { id: "s1", user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null }, score: 50, createdAt: "", rank: 2 };
    const submitScore = vi.spyOn(client, "submitScore").mockResolvedValue(saved);
    const onScore = vi.fn();
    const { container } = render(
      <WebGameProviders config={{ apiBaseUrl: "", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <GamePlayer game={game} onScoreSubmitted={onScore} />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await waitFor(() => expect(client.me).toHaveBeenCalled());
    await act(async () => {});
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe("/play/g1?v=3");
    post(iframe.contentWindow, { type: "webgame:score", score: "nope" });
    post(iframe.contentWindow, { type: "webgame:score", score: 50 });
    await waitFor(() => expect(onScore).toHaveBeenCalledWith(saved));
    expect(submitScore).toHaveBeenCalledTimes(1);
    expect(submitScore).toHaveBeenCalledWith("g1", 50);
    expect(await screen.findByText(/Score saved: 50/)).toBeTruthy();
  });

  describe("storage persistence", () => {
    it("replies to hello with the saved data (via the game frame, targetOrigin *)", () => {
      localStorage.setItem("webgame.save.g1", JSON.stringify({ level: 4, best: 99 }));
      const { iframe } = setup();
      const spy = vi.spyOn(iframe.contentWindow!, "postMessage");
      post(iframe.contentWindow, { type: "webgame:hello" });
      expect(spy).toHaveBeenCalledWith({ type: "webgame:load", data: { level: 4, best: 99 } }, "*");
    });

    it("replies to hello with null when nothing (or garbage) is saved", () => {
      localStorage.setItem("webgame.save.g1", "{not json");
      const { iframe } = setup();
      const spy = vi.spyOn(iframe.contentWindow!, "postMessage");
      post(iframe.contentWindow, { type: "webgame:hello" });
      expect(spy).toHaveBeenCalledWith({ type: "webgame:load", data: null }, "*");
    });

    it("persists saves from the game frame", () => {
      const { iframe } = setup();
      post(iframe.contentWindow, { type: "webgame:save", data: { coins: 3 } });
      expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ coins: 3 });
      post(iframe.contentWindow, { type: "webgame:save", data: [1, 2] });
      post(iframe.contentWindow, { type: "webgame:save", data: "x" });
      expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ coins: 3 });
    });

    it("ignores saves and hellos from a foreign source", () => {
      const { iframe } = setup();
      const other = document.createElement("iframe");
      document.body.appendChild(other);
      const spy = vi.spyOn(iframe.contentWindow!, "postMessage");
      const otherSpy = vi.spyOn(other.contentWindow!, "postMessage");
      post(other.contentWindow, { type: "webgame:save", data: { hacked: true } });
      post(window, { type: "webgame:save", data: { hacked: true } });
      post(null, { type: "webgame:save", data: { hacked: true } });
      post(other.contentWindow, { type: "webgame:hello" });
      expect(localStorage.getItem("webgame.save.g1")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(otherSpy).not.toHaveBeenCalled();
      other.remove();
    });

    it("ignores oversize saves (> 256KB) and warns", () => {
      localStorage.setItem("webgame.save.g1", JSON.stringify({ keep: 1 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { iframe } = setup();
      post(iframe.contentWindow, { type: "webgame:save", data: { blob: "x".repeat(256 * 1024) } });
      expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ keep: 1 });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("owner preview of unpublished games", () => {
    const draft = { ...game, published: false, isOwner: true };
    const me = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z" };

    function renderDraft(createPreviewToken: () => Promise<{ token: string; expiresAt: string }>, g: typeof draft = draft) {
      localStorage.setItem("webgame.token", "SESSION.JWT.secret");
      const client = new ApiClient({ baseUrl: "http://api.test" });
      vi.spyOn(client, "me").mockResolvedValue(me);
      const spy = vi.spyOn(client, "createPreviewToken").mockImplementation(createPreviewToken);
      const ui = (
        <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
          <MemoryRouter>
            <GamePlayer game={g} />
          </MemoryRouter>
        </WebGameProviders>
      );
      const utils = render(ui);
      return { ...utils, client, spy, ui };
    }

    const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

    it("uses a preview token, never the session token, in the iframe src", async () => {
      const { container, spy } = renderDraft(async () => ({ token: "PREVIEW.tok", expiresAt: future() }));
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const src = container.querySelector("iframe")!.getAttribute("src")!;
      expect(src).toBe("http://api.test/play/g1?token=PREVIEW.tok&v=3");
      expect(src).not.toContain("SESSION");
      expect(spy).toHaveBeenCalledWith("g1");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("renders no iframe until the preview token arrives, and shows an error if minting fails", async () => {
      const { container } = renderDraft(() => Promise.reject(new Error("nope")));
      expect(container.querySelector("iframe")).toBeNull();
      expect(await screen.findByText(/Couldn't start the preview/)).toBeTruthy();
      expect(container.querySelector("iframe")).toBeNull();
    });

    it("mints a fresh token when remounted after the previous one expired", async () => {
      let n = 0;
      const { container, spy, unmount, ui } = renderDraft(async () => {
        n += 1;
        return { token: `P${n}`, expiresAt: n === 1 ? new Date(Date.now() - 1000).toISOString() : future() };
      });
      await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toContain("token=P1"));
      unmount();
      const again = render(ui);
      await waitFor(() => expect(again.container.querySelector("iframe")?.getAttribute("src")).toContain("token=P2"));
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("restart re-mints an expired preview token", async () => {
      let n = 0;
      const { container, spy } = renderDraft(async () => {
        n += 1;
        return { token: `R${n}`, expiresAt: n === 1 ? new Date(Date.now() - 1000).toISOString() : future() };
      });
      await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toContain("token=R1"));
      act(() => screen.getByRole("button", { name: "Restart game" }).click());
      await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toContain("token=R2"));
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("published games (even for the owner) and non-owners get no token at all", async () => {
      for (const g of [{ ...draft, published: true }, { ...draft, isOwner: false }]) {
        const { container, spy, unmount } = renderDraft(async () => ({ token: "PREVIEW.tok", expiresAt: future() }), g);
        await act(async () => {});
        const src = container.querySelector("iframe")!.getAttribute("src")!;
        expect(src).toBe("http://api.test/play/g1?v=3");
        expect(spy).not.toHaveBeenCalled();
        unmount();
      }
    });
  });
});
