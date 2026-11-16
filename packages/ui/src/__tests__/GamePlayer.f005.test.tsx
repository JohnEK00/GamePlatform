import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { User } from "../api/types";
import { GamePlayer } from "../components/GamePlayer";
import { SCREENSHOT_SHARE_MAX_PER_MOUNT, SCREENSHOT_TRAY_MAX } from "../components/useScreenshotCapture";
import { PLAYER_SCREENSHOT_EVENT } from "../screenshot";
import { WebGameProviders } from "../WebGameApp";
import { blobOf, pngBytes } from "./imageBytes";

const game = { id: "g1", title: "Space Dodge", width: 320, height: 180, playUrl: "/play/g1", version: 3, published: true, isOwner: false };
const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

async function flush(ms = 0) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
  });
}

/** What the "game" sends: the browser would accept anything here, so tests use both real PNG-typed and hostile blobs. */
const pngFromGame = () => blobOf(pngBytes(320, 180));
const htmlFromGame = () => new Blob(["<script>alert(document.cookie)</script>"], { type: "text/html" });

let createUrl: ReturnType<typeof vi.fn>;
let revokeUrl: ReturnType<typeof vi.fn>;
/** Blobs produced by our (fake) canvas encoder: the only ones allowed to get an object URL. */
let encoded: Blob[];
const origCreate = (URL as { createObjectURL?: unknown }).createObjectURL;
const origRevoke = (URL as { revokeObjectURL?: unknown }).revokeObjectURL;

beforeEach(() => {
  encoded = [];
  let n = 0;
  createUrl = vi.fn(() => `blob:test/${++n}`);
  revokeUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { value: createUrl, configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeUrl, configurable: true, writable: true });
  // createImageBitmap rejects non-images, like the real one.
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (b: Blob) => {
      if (b.type !== "image/png") throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return { width: 320, height: 180, close: vi.fn() };
    }),
  );
  const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "", imageSmoothingEnabled: true, imageSmoothingQuality: "low" };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback, type?: string) {
    const b = new Blob([new Uint8Array([1, 2, 3, 4])], { type: type ?? "image/png" });
    encoded.push(b);
    cb(b);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", { value: origCreate, configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: origRevoke, configurable: true, writable: true });
});

async function setup({ ready = true } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "getSave").mockResolvedValue({ data: null, updatedAt: null });
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={game} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await flush();
  const iframe = utils.container.querySelector("iframe")!;
  const win = iframe.contentWindow!;
  const frameSpy = vi.spyOn(win, "postMessage");
  if (ready) post(win, { type: "webgame:ready" });
  await flush();
  return { ...utils, client, iframe, win, frameSpy };
}

const sent = (spy: { mock: { calls: unknown[][] } }, type: string) =>
  spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === type);
const cameraButton = () => screen.getByRole("button", { name: "Take screenshot" });
const trayItems = () => screen.queryAllByRole("button", { name: /^Screenshot \d+, captured / });

async function requestCapture(win: Window, frameSpy: { mock: { calls: unknown[][] } }) {
  fireEvent.click(cameraButton());
  await flush();
  const reqs = sent(frameSpy, "webgame:screenshot-request");
  const id = reqs[reqs.length - 1]?.requestId as string;
  return id;
}

describe("GamePlayer screenshots (F005)", () => {
  it("is disabled until webgame:ready, then posts a request to the iframe window", async () => {
    const { win, frameSpy } = await setup({ ready: false });
    expect(cameraButton().getAttribute("aria-disabled")).toBe("true");
    post(win, { type: "webgame:ready" });
    await flush();
    expect(cameraButton().getAttribute("aria-disabled")).toBe("false");
    const id = await requestCapture(win, frameSpy);
    expect(sent(frameSpy, "webgame:screenshot-request")).toEqual([{ type: "webgame:screenshot-request", requestId: "ps-1" }]);
    expect(id).toBe("ps-1");
    // One in flight: the button is aria-disabled (still focusable, review 3 L1a) and a second click sends nothing.
    expect((cameraButton() as HTMLButtonElement).disabled).toBe(false);
    expect(cameraButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cameraButton());
    expect(sent(frameSpy, "webgame:screenshot-request")).toHaveLength(1);
  });

  it("adds the laundered image to the tray and announces it", async () => {
    const { win, frameSpy, container } = await setup();
    const id = await requestCapture(win, frameSpy);
    const raw = pngFromGame();
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: raw, width: 320, height: 180 });
    await flush();
    expect(trayItems()).toHaveLength(1);
    expect(container.querySelector(".pf-shot-flash")).toBeTruthy();
    expect(screen.getByText("Screenshot captured")).toBeTruthy();
    expect(cameraButton().getAttribute("aria-disabled")).toBe("false");
    // The one object URL is for our re-encoded PNG, never for the game's blob.
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(createUrl.mock.calls[0][0]).not.toBe(raw);
    expect(encoded).toContain(createUrl.mock.calls[0][0]);
  });

  it("ignores replies from another source", async () => {
    const { win, frameSpy } = await setup();
    const id = await requestCapture(win, frameSpy);
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(other.contentWindow, { type: "webgame:screenshot", requestId: id, source: "player", image: pngFromGame(), width: 1, height: 1 });
    post(window, { type: "webgame:screenshot", requestId: id, source: "player", image: pngFromGame(), width: 1, height: 1 });
    await flush();
    expect(trayItems()).toHaveLength(0);
    expect(createUrl).not.toHaveBeenCalled();
    // Still waiting for the real reply.
    expect(cameraButton().getAttribute("aria-disabled")).toBe("true");
    other.remove();
  });

  it("ignores a mismatched id and malformed messages", async () => {
    const { win, frameSpy } = await setup();
    const id = await requestCapture(win, frameSpy);
    post(win, { type: "webgame:screenshot", requestId: "ps-999", source: "player", image: pngFromGame() });
    post(win, { type: "webgame:screenshot", requestId: "", source: "player", image: pngFromGame() });
    post(win, { type: "webgame:screenshot", requestId: id, source: "admin", image: pngFromGame() });
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: "data:image/png;base64,AAAA" });
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: "image/png" }) });
    await flush();
    expect(trayItems()).toHaveLength(0);
    expect(createUrl).not.toHaveBeenCalled();
    // The genuine reply still works afterwards.
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: pngFromGame() });
    await flush();
    expect(trayItems()).toHaveLength(1);
  });

  it("times out after 5 s with a toast, and maps engine errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { win, frameSpy } = await setup();
    const id = await requestCapture(win, frameSpy);
    await flush(4999);
    expect(screen.queryByText("Couldn't capture a screenshot")).toBeNull();
    await flush(1);
    expect(screen.getByText("Couldn't capture a screenshot")).toBeTruthy();
    expect(screen.getByText("This game can't take screenshots right now")).toBeTruthy();
    expect(cameraButton().getAttribute("aria-disabled")).toBe("false");
    // A late reply to the timed-out request is ignored.
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: pngFromGame() });
    await flush();
    expect(trayItems()).toHaveLength(0);

    const id2 = await requestCapture(win, frameSpy);
    expect(id2).toBe("ps-2");
    post(win, { type: "webgame:screenshot", requestId: id2, source: "player", error: "busy" });
    await flush();
    expect(screen.getByText("Try again in a moment")).toBeTruthy();
    // The earlier request's timer can't fire for the new one.
    const id3 = await requestCapture(win, frameSpy);
    post(win, { type: "webgame:screenshot", requestId: id3, source: "player", error: "unavailable" });
    await flush();
    expect(screen.getByText("The game is still loading")).toBeTruthy();
  });

  it("accepts game shares with a sanitised caption and rate-limits them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:screenshot", requestId: "ss-1", source: "game", image: pngFromGame(), caption: "New best:‮ 12,340\n" });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")).toEqual([{ type: "webgame:screenshot-result", requestId: "ss-1", accepted: true }]);
    expect(screen.getByText("Space Dodge captured a screenshot")).toBeTruthy();
    expect(trayItems()).toHaveLength(1);
    expect(screen.getByText("from game")).toBeTruthy();

    // Within 3 s → rate_limited.
    await flush(2999);
    post(win, { type: "webgame:screenshot", requestId: "ss-2", source: "game", image: pngFromGame() });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")[1]).toEqual({ type: "webgame:screenshot-result", requestId: "ss-2", accepted: false, error: "rate_limited" });
    expect(trayItems()).toHaveLength(1);

    // The caption reached the dialog sanitised.
    fireEvent.click(trayItems()[0]);
    expect((screen.getByLabelText(/Caption/) as HTMLInputElement).value).toBe("New best: 12,340");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // 20 per mount, and the tray keeps the newest 12 (evicted URLs revoked).
    for (let i = 2; i <= SCREENSHOT_SHARE_MAX_PER_MOUNT + 1; i++) {
      await flush(3000);
      post(win, { type: "webgame:screenshot", requestId: `ss-x${i}`, source: "game", image: pngFromGame() });
      await flush();
    }
    const results = sent(frameSpy, "webgame:screenshot-result");
    expect(results.filter((r) => r.accepted === true)).toHaveLength(SCREENSHOT_SHARE_MAX_PER_MOUNT);
    expect(results.at(-1)).toEqual({ type: "webgame:screenshot-result", requestId: `ss-x${SCREENSHOT_SHARE_MAX_PER_MOUNT + 1}`, accepted: false, error: "rate_limited" });
    expect(trayItems()).toHaveLength(SCREENSHOT_TRAY_MAX);
    expect(revokeUrl).toHaveBeenCalledTimes(SCREENSHOT_SHARE_MAX_PER_MOUNT - SCREENSHOT_TRAY_MAX);
  });

  it("replies invalid for a blob that isn't an image, without an object URL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:screenshot", requestId: "ss-1", source: "game", image: htmlFromGame() });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")).toEqual([{ type: "webgame:screenshot-result", requestId: "ss-1", accepted: false, error: "invalid" }]);
    expect(trayItems()).toHaveLength(0);
    expect(createUrl).not.toHaveBeenCalled();
    // A failed share uses up its 3 s slot (no refund, review 3 M1).
    post(win, { type: "webgame:screenshot", requestId: "ss-2", source: "game", image: pngFromGame() });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")[1]).toEqual({ type: "webgame:screenshot-result", requestId: "ss-2", accepted: false, error: "rate_limited" });
    await flush(3000);
    post(win, { type: "webgame:screenshot", requestId: "ss-3", source: "game", image: pngFromGame() });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")[2]).toMatchObject({ requestId: "ss-3", accepted: true });
  });

  it("rejects a decompression-bomb share from its header without decoding, and keeps the slot (review 3, M1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { win, frameSpy } = await setup();
    // A tiny PNG whose IHDR claims 30000×30000 (3.35 GiB decoded).
    post(win, { type: "webgame:screenshot", requestId: "ss-1", source: "game", image: blobOf(pngBytes(30000, 30000)) });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-result")).toEqual([{ type: "webgame:screenshot-result", requestId: "ss-1", accepted: false, error: "invalid" }]);
    expect(createImageBitmap).not.toHaveBeenCalled();
    // Back-to-back bombs are throttled, not decoded.
    for (let i = 2; i <= 5; i++) post(win, { type: "webgame:screenshot", requestId: `ss-${i}`, source: "game", image: blobOf(pngBytes(30000, 30000)) });
    await flush();
    const results = sent(frameSpy, "webgame:screenshot-result");
    expect(results.slice(1).every((r) => r.error === "rate_limited")).toBe(true);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("player captures with an oversized header are rejected without decoding", async () => {
    const { win, frameSpy } = await setup();
    const id = await requestCapture(win, frameSpy);
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: blobOf(pngBytes(16384, 16384)) });
    await flush();
    expect(screen.getByText("Couldn't capture a screenshot")).toBeTruthy();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("player captures of a hostile blob show a toast and never get an object URL", async () => {
    const { win, frameSpy } = await setup();
    const id = await requestCapture(win, frameSpy);
    post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: htmlFromGame() });
    await flush();
    expect(screen.getByText("Couldn't capture a screenshot")).toBeTruthy();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("PLAYER_SCREENSHOT_EVENT triggers a capture", async () => {
    const { frameSpy } = await setup();
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAYER_SCREENSHOT_EVENT));
    });
    await flush();
    expect(sent(frameSpy, "webgame:screenshot-request")).toEqual([{ type: "webgame:screenshot-request", requestId: "ps-1" }]);
  });

  it("never creates an object URL for any blob the game sent, and revokes on unmount", async () => {
    const { win, frameSpy, unmount } = await setup();
    const raws: Blob[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await requestCapture(win, frameSpy);
      const raw = pngFromGame();
      raws.push(raw);
      post(win, { type: "webgame:screenshot", requestId: id, source: "player", image: raw });
      await flush();
    }
    const raw = pngFromGame();
    raws.push(raw);
    post(win, { type: "webgame:screenshot", requestId: "ss-1", source: "game", image: raw });
    await flush();
    expect(trayItems()).toHaveLength(4);
    expect(createUrl).toHaveBeenCalledTimes(4);
    for (const [arg] of createUrl.mock.calls) {
      expect(raws).not.toContain(arg);
      expect(encoded).toContain(arg);
    }
    unmount();
    expect(revokeUrl).toHaveBeenCalledTimes(4);
  });
});
