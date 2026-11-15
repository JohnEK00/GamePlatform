import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Notification, UnreadCount } from "../api/types";
import type { OsNotifications } from "../context/config";
import { useNotifications } from "../context/notifications";
import { OS_WATERMARK_PREFIX } from "../notifications";
import { WebGameProviders } from "../WebGameApp";
import { me, notif } from "./notifFixtures";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});
const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

function Probe() {
  const n = useNotifications();
  return <output data-testid="probe">{`${n.supported}|${n.unread}|${n.latestAt}`}</output>;
}

type CountResult = UnreadCount | Error;

function setup(opts: { counts?: CountResult[]; poll?: number; os?: OsNotifications; list?: Notification[] } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const queue = [...(opts.counts ?? [])];
  let last: CountResult = { unread: 0, latestAt: null, pollAfterSecs: opts.poll ?? 60 };
  const count = vi.spyOn(client, "unreadNotificationCount").mockImplementation(async () => {
    if (queue.length) last = queue.shift()!;
    if (last instanceof Error) throw last;
    return last;
  });
  const list = vi.spyOn(client, "listNotifications").mockImplementation(async () => ({ items: opts.list ?? [], nextCursor: null, unread: 0 }));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser", platform: { osNotifications: opts.os } }} client={client}>
      <Probe />
    </WebGameProviders>,
  );
  const probe = () => utils.getByTestId("probe").textContent;
  const live = () => document.querySelector(".pf-notif-live")?.textContent ?? "";
  return { client, count, list, probe, live, ...utils };
}

const c = (unread: number, latestAt: string | null = null, pollAfterSecs = 60): UnreadCount => ({ unread, latestAt, pollAfterSecs });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe("NotificationsProvider poll loop", () => {
  it("fetches on mount, then again pollAfterSecs after the last response", async () => {
    const { count, probe } = setup({ counts: [c(2, "2026-11-15T11:00:00.000Z", 30)] });
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
    expect(probe()).toBe("true|2|2026-11-15T11:00:00.000Z");
    await advance(29_900);
    expect(count).toHaveBeenCalledTimes(1);
    await advance(100);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while signed out", async () => {
    localStorage.removeItem("webgame.token");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const count = vi.spyOn(client, "unreadNotificationCount").mockResolvedValue(c(1));
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <Probe />
      </WebGameProviders>,
    );
    await advance(10 * 60_000);
    expect(count).not.toHaveBeenCalled();
  });

  it("pauses while hidden and fetches at once when visible again (last fetch > 15 s ago)", async () => {
    const { count } = setup();
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    await advance(10 * 60_000);
    expect(count).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await flush();
    expect(count).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("a timer scheduled while visible reads the latest state when it fires (hidden → no fetch)", async () => {
    const { count } = setup();
    await flush();
    await advance(30_000);
    // Hide without the event (e.g. a missed visibilitychange): the pending timer must re-check.
    visibility = "hidden";
    await advance(5 * 60_000);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("polls at 2 × pollAfterSecs while hidden when OS notifications are on", async () => {
    const os = { isEnabled: vi.fn(() => true), show: vi.fn(async () => {}) };
    const { count } = setup({ os });
    await flush();
    act(() => setVisibility("hidden"));
    await advance(60_000);
    expect(count).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(120_000);
    expect(count).toHaveBeenCalledTimes(3);
    // Turning it off while hidden pauses at the next check.
    os.isEnabled.mockReturnValue(false);
    await advance(10 * 60_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("window focus refetches only when the last fetch is older than 15 s", async () => {
    const { count } = setup();
    await flush();
    await advance(10_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
    await advance(6_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(count).toHaveBeenCalledTimes(2);
    // The cadence restarts from that response.
    await advance(59_000);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("429: waits Retry-After (at least pollAfterSecs); focus does not bypass it", async () => {
    const limited = new ApiError("rate_limited", "slow", 429, 300);
    const { count } = setup({ counts: [limited, c(1)] });
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
    await advance(120_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(179_000);
    expect(count).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("errors back off 2×, 4× and reset after a success", async () => {
    const net = () => new ApiError("network", "down", 0);
    const { count } = setup({ counts: [net(), net(), c(0), c(0)] });
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
    await advance(119_000);
    expect(count).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(239_000);
    expect(count).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(count).toHaveBeenCalledTimes(3); // success
    await advance(60_000);
    expect(count).toHaveBeenCalledTimes(4);
  });

  it("404 (older server): stops polling and reports unsupported", async () => {
    const { count, probe } = setup({ counts: [new ApiError("not_found", "nope", 404)] });
    await flush();
    expect(probe()).toBe("false|0|null");
    await advance(30 * 60_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("401: stops until the user changes", async () => {
    const { count } = setup({ counts: [new ApiError("unauthorized", "no", 401)] });
    await flush();
    await advance(30 * 60_000);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("sign-out stops polling and clears state", async () => {
    const { count, probe } = setup({ counts: [c(4, "2026-11-15T11:00:00.000Z")] });
    await flush();
    expect(probe()).toBe("true|4|2026-11-15T11:00:00.000Z");
    act(() => {
      localStorage.removeItem("webgame.token");
      window.dispatchEvent(new StorageEvent("storage", { key: "webgame.token", newValue: null }));
    });
    await flush();
    expect(probe()).toBe("false|0|null");
    await advance(10 * 60_000);
    expect(count).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationsProvider live region", () => {
  it("announces increases only, never the first load or decreases", async () => {
    const { live } = setup({ counts: [c(3, "2026-11-15T10:00:00.000Z"), c(1, "2026-11-15T10:00:00.000Z"), c(2, "2026-11-15T11:00:00.000Z"), c(5, "2026-11-15T11:30:00.000Z")] });
    await flush();
    expect(live()).toBe("");
    await advance(60_000);
    expect(live()).toBe("");
    await advance(60_000);
    expect(live()).toBe("1 new notification");
    await advance(60_000);
    expect(live()).toBe("3 new notifications");
    expect(document.querySelectorAll(".pf-notif-live")).toHaveLength(1);
  });
});

describe("NotificationsProvider OS notifications", () => {
  const key = OS_WATERMARK_PREFIX + me.id;
  const at = (min: number) => `2026-11-15T11:${String(min).padStart(2, "0")}:00.000Z`;

  it("first enabled poll only sets the watermark (no burst of old ones)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const os = { isEnabled: () => true, show: vi.fn(async () => {}) };
    const { list } = setup({ os, counts: [c(5, at(10))] });
    await flush();
    expect(localStorage.getItem(key)).toBe(at(10));
    expect(os.show).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("1–3 new items: one OS notification each, oldest first, no excerpts; watermark moves to the newest", async () => {
    localStorage.setItem(key, at(0));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const os = { isEnabled: () => true, show: vi.fn(async () => {}) };
    const items = [
      notif({ id: "3", kind: "follow", game: null, updatedAt: at(3) }),
      notif({ id: "2", excerpt: "do not leak", updatedAt: at(2) }),
      notif({ id: "1", updatedAt: at(0) }), // not newer than the watermark
    ];
    const { list } = setup({ os, counts: [c(3, at(3))], list: items });
    await flush();
    expect(list).toHaveBeenCalledWith({ unread: true, limit: 5 });
    expect(os.show.mock.calls.map((x) => (x as unknown[])[0])).toEqual([
      { title: "Pixelforge Arcade", body: "Mia commented on Pixel Peaks" },
      { title: "Pixelforge Arcade", body: "Mia followed you" },
    ]);
    expect(localStorage.getItem(key)).toBe(at(3));
    // Same latestAt on the next poll: nothing new.
    await advance(60_000);
    expect(os.show).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("more than 3 new items: a single summary", async () => {
    localStorage.setItem(key, at(0));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const os = { isEnabled: () => true, show: vi.fn(async () => {}) };
    const items = [5, 4, 3, 2].map((m) => notif({ id: String(m), updatedAt: at(m) }));
    setup({ os, counts: [c(4, at(5))], list: items });
    await flush();
    expect(os.show).toHaveBeenCalledTimes(1);
    expect(os.show).toHaveBeenCalledWith({ title: "Pixelforge Arcade", body: "You have 4 new notifications" });
    expect(localStorage.getItem(key)).toBe(at(5));
  });

  it("never while the window has focus (watermark still advances)", async () => {
    localStorage.setItem(key, at(0));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const os = { isEnabled: () => true, show: vi.fn(async () => {}) };
    const { list } = setup({ os, counts: [c(1, at(4))], list: [notif({ id: "1", updatedAt: at(4) })] });
    await flush();
    expect(os.show).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(at(4));
  });

  it("nothing when OS notifications are off", async () => {
    localStorage.setItem(key, at(0));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const os = { isEnabled: () => false, show: vi.fn(async () => {}) };
    const { list } = setup({ os, counts: [c(1, at(4))], list: [notif({ id: "1", updatedAt: at(4) })] });
    await flush();
    expect(os.show).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(at(0));
  });

  it("turning it on resets the watermark to the current newest", async () => {
    localStorage.setItem(key, at(0));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const os = { isEnabled: vi.fn(() => false), show: vi.fn(async () => {}) };
    setup({ os, counts: [c(1, at(4)), c(2, at(6)), c(3, at(8))], list: [notif({ id: "9", updatedAt: at(8) })] });
    await flush();
    os.isEnabled.mockReturnValue(true);
    await advance(60_000);
    expect(localStorage.getItem(key)).toBe(at(6));
    expect(os.show).not.toHaveBeenCalled();
    await advance(60_000);
    expect(os.show).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(at(8));
  });
});
