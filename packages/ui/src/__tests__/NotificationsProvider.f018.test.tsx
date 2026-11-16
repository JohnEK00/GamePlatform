// F018 § 2.6: one polling tab per browser. Two providers ("tabs") share an in-memory lock manager and channel bus.
import { act, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Notification, UnreadCount } from "../api/types";
import type { OsNotifications } from "../context/config";
import { useNotifications, type NotificationsState } from "../context/notifications";
import { tabScope, type ChannelLike, type LockManagerLike } from "../notificationsTabs";
import { WebGameProviders } from "../WebGameApp";
import { me, notif } from "./notifFixtures";

// ---------- In-memory Web Locks (exclusive, FIFO, AbortSignal while queued) ----------

type LockEntry = { cb: (lock: unknown) => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };

class FakeLocks implements LockManagerLike {
  private holders = new Map<string, LockEntry>();
  private waiting = new Map<string, LockEntry[]>();

  request(name: string, options: { signal?: AbortSignal }, cb: (lock: unknown) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abortError = () => new DOMException("The request was aborted.", "AbortError");
      if (options.signal?.aborted) return reject(abortError());
      const entry: LockEntry = { cb, resolve, reject };
      const q = this.waiting.get(name) ?? [];
      this.waiting.set(name, q);
      q.push(entry);
      options.signal?.addEventListener("abort", () => {
        const i = q.indexOf(entry);
        if (i >= 0) {
          q.splice(i, 1);
          reject(abortError());
        }
      });
      this.pump(name);
    });
  }

  holder(name: string) {
    return this.holders.get(name) ?? null;
  }

  private pump(name: string) {
    if (this.holders.has(name)) return;
    const next = this.waiting.get(name)?.shift();
    if (!next) return;
    this.holders.set(name, next);
    queueMicrotask(async () => {
      try {
        next.resolve(await next.cb({ name, mode: "exclusive" }));
      } catch (e) {
        next.reject(e);
      } finally {
        this.holders.delete(name);
        this.pump(name);
      }
    });
  }
}

// ---------- In-memory BroadcastChannel bus (never delivers to the sender, structured-clone-like copies) ----------

class Bus {
  channels = new Set<FakeChannel>();
  sent: { name: string; data: unknown }[] = [];
  create = (name: string): ChannelLike => {
    const c = new FakeChannel(name, this);
    this.channels.add(c);
    return c;
  };
  deliver(from: FakeChannel | null, name: string, message: unknown) {
    const data = JSON.parse(JSON.stringify(message));
    this.sent.push({ name, data });
    for (const c of this.channels) if (c !== from && c.name === name) queueMicrotask(() => c.onmessage?.({ data }));
  }
}

class FakeChannel implements ChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    readonly name: string,
    private bus: Bus,
  ) {}
  postMessage(message: unknown) {
    if (!this.bus.channels.has(this)) throw new DOMException("closed", "InvalidStateError");
    this.bus.deliver(this, this.name, message);
  }
  close() {
    this.bus.channels.delete(this);
  }
}

// ---------- Harness ----------

const HANG = Symbol("hang");
type CountResult = UnreadCount | Error | typeof HANG;

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function Probe({ out }: { out: { current: NotificationsState | null } }) {
  const n = useNotifications();
  out.current = n;
  return <output data-testid="probe">{`${n.supported}|${n.unread}|${n.latestAt}`}</output>;
}

let locks: FakeLocks;
let bus: Bus;
const SCOPE = tabScope("http://api.test", me.id);

type TabOpts = { counts?: CountResult[]; os?: OsNotifications; list?: Notification[]; visible?: () => boolean; coordinated?: boolean };

function mountTab(opts: TabOpts = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const queue = [...(opts.counts ?? [])];
  let last: CountResult = c(0);
  const count = vi.spyOn(client, "unreadNotificationCount").mockImplementation(() => {
    if (queue.length) last = queue.shift()!;
    if (last === HANG) return new Promise<UnreadCount>(() => {});
    if (last instanceof Error) return Promise.reject(last);
    return Promise.resolve(last);
  });
  const list = vi.spyOn(client, "listNotifications").mockImplementation(async () => ({ items: opts.list ?? [], nextCursor: null, unread: 0 }));
  const markRead = vi.spyOn(client, "markNotificationsRead").mockResolvedValue({ unread: 0 });
  const out: { current: NotificationsState | null } = { current: null };
  const tabs = opts.coordinated === false ? { locks: null, createChannel: null, isVisible: opts.visible } : { locks, createChannel: bus.create, isVisible: opts.visible };
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser", platform: { osNotifications: opts.os } }} client={client} notificationTabs={tabs}>
      <Probe out={out} />
    </WebGameProviders>,
  );
  return {
    client,
    count,
    list,
    markRead,
    state: () => out.current!,
    probe: () => within(utils.container).getByTestId("probe").textContent,
    live: () => utils.container.querySelector(".pf-notif-live")?.textContent ?? "",
    unmount: () => utils.unmount(),
  };
}

const c = (unread: number, latestAt: string | null = null, pollAfterSecs = 60): UnreadCount => ({ unread, latestAt, pollAfterSecs });
const T1 = "2026-11-15T11:00:00.000Z";
const T2 = "2026-11-15T11:30:00.000Z";
const T3 = "2026-11-15T11:45:00.000Z";

/** Mounts the leader (A) first, then a follower (B). */
async function twoTabs(a: TabOpts = {}, b: TabOpts = {}) {
  const A = mountTab(a);
  await flush();
  const B = mountTab(b);
  await flush();
  return { A, B };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
  locks = new FakeLocks();
  bus = new Bus();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe("NotificationsProvider F018: leader and follower", () => {
  it("only the leader requests the count; both bells match; an arrival is announced in both tabs", async () => {
    const { A, B } = await twoTabs({ counts: [c(2, T1), c(3, T2)] });
    expect(locks.holder(SCOPE + ".leader")).not.toBeNull();
    expect(A.count).toHaveBeenCalledTimes(1);
    expect(B.count).not.toHaveBeenCalled();
    // The follower asked for the count on start; the leader's count is fresh, so it re-posted it.
    expect(A.probe()).toBe(`true|2|${T1}`);
    expect(B.probe()).toBe(`true|2|${T1}`);
    expect(bus.sent.some((m) => (m.data as { type: string }).type === "poll")).toBe(true);

    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(2);
    expect(B.count).not.toHaveBeenCalled();
    expect(A.probe()).toBe(`true|3|${T2}`);
    expect(B.probe()).toBe(`true|3|${T2}`);
    expect(A.live()).toBe("1 new notification");
    expect(B.live()).toBe("1 new notification");
    expect(A.state().arrivals).toBe(1);
    expect(B.state().arrivals).toBe(1);

    // Messages never carry tokens or items.
    for (const m of bus.sent) expect(JSON.stringify(m.data)).not.toMatch(/tok|excerpt|items/);
  });

  it("closing the leader hands over: the follower polls at once when its count is stale", async () => {
    const { A, B } = await twoTabs({ counts: [c(1, T1)] }, { counts: [c(4, T2)] });
    await advance(20_000);
    expect(B.count).not.toHaveBeenCalled();
    act(() => A.unmount());
    await flush();
    expect(B.count).toHaveBeenCalledTimes(1);
    expect(B.probe()).toBe(`true|4|${T2}`);
    await advance(60_000);
    expect(B.count).toHaveBeenCalledTimes(2);
  });

  it("closing the leader hands over: a fresh follower keeps the cadence from the last count", async () => {
    const { A, B } = await twoTabs({ counts: [c(1, T1)] });
    await advance(5_000);
    act(() => A.unmount());
    await flush();
    expect(B.count).not.toHaveBeenCalled();
    await advance(54_000); // 59 s after the leader's count
    expect(B.count).not.toHaveBeenCalled();
    await advance(1_000);
    expect(B.count).toHaveBeenCalledTimes(1);
  });

  it("a hidden leader keeps polling for a visible follower and stops 75 s after the last ping", async () => {
    let visA = true;
    let visB = true;
    const { A, B } = await twoTabs({ visible: () => visA }, { visible: () => visB });
    expect(A.count).toHaveBeenCalledTimes(1);
    visA = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(3);
    // The follower is hidden from t = 125 s; its last ping was at t = 120 s.
    await advance(5_000);
    visB = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(55_000); // t = 180 s: the ping is 60 s old, still within 75 s
    expect(A.count).toHaveBeenCalledTimes(4);
    await advance(10 * 60_000);
    expect(A.count).toHaveBeenCalledTimes(4);
    expect(B.count).not.toHaveBeenCalled();
    // The follower becomes visible again: its ping wakes the paused leader, which polls at once (stale).
    visB = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(A.count).toHaveBeenCalledTimes(5);
    expect(B.count).not.toHaveBeenCalled();
  });

  it("markAllRead in one tab updates the other tab's unread (both directions)", async () => {
    const { A, B } = await twoTabs({ counts: [c(5, T1)] });
    expect(B.probe()).toBe(`true|5|${T1}`);
    await act(async () => {
      await A.state().markAllRead(T1);
    });
    await flush();
    expect(A.probe()).toBe(`true|0|${T1}`);
    expect(B.probe()).toBe(`true|0|${T1}`);
    act(() => B.state().syncUnread(7));
    await flush();
    expect(A.probe()).toBe(`true|7|${T1}`);
    expect(A.count).toHaveBeenCalledTimes(1);
  });

  it("a follower's refresh() makes one request and resets the leader's schedule (no double poll)", async () => {
    const { A, B } = await twoTabs({ counts: [c(1, T1)] }, { counts: [c(2, T2)] });
    await advance(30_000);
    await act(async () => {
      await B.state().refresh();
    });
    await flush();
    expect(B.count).toHaveBeenCalledTimes(1);
    expect(A.probe()).toBe(`true|2|${T2}`);
    await advance(30_000); // t = 60 s: the leader's old slot
    expect(A.count).toHaveBeenCalledTimes(1);
    await advance(30_000); // t = 90 s: 60 s after the follower's response
    expect(A.count).toHaveBeenCalledTimes(2);
    expect(B.count).toHaveBeenCalledTimes(1);
  });

  it("watchdog: a visible follower requests the count once when the leader goes silent", async () => {
    const { A, B } = await twoTabs({ counts: [c(1, T1), HANG] }, { counts: [c(2, T2)] });
    expect(B.probe()).toBe(`true|1|${T1}`);
    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(2); // in flight forever
    await advance(119_000); // t = 179 s
    expect(B.count).not.toHaveBeenCalled();
    await advance(1_000); // t = 180 s = max(3 × 60, 180)
    expect(B.count).toHaveBeenCalledTimes(1);
    expect(B.probe()).toBe(`true|2|${T2}`);
    expect(A.probe()).toBe(`true|2|${T2}`);
    await advance(179_000);
    expect(B.count).toHaveBeenCalledTimes(1);
  });

  it("watchdog: a follower that gets no count within 5 s of starting requests it itself", async () => {
    const { B } = await twoTabs({ counts: [HANG] }, { counts: [c(3, T1)] });
    await advance(4_900);
    expect(B.count).not.toHaveBeenCalled();
    await advance(100);
    expect(B.count).toHaveBeenCalledTimes(1);
    expect(B.probe()).toBe(`true|3|${T1}`);
  });

  it("ignores messages for another user and malformed ones", async () => {
    const { B } = await twoTabs({ counts: [c(1, T1)] });
    act(() => {
      bus.deliver(null, SCOPE, { v: 1, userId: "u-other", type: "unread", unread: 9 });
      bus.deliver(null, SCOPE, { v: 2, userId: me.id, type: "unread", unread: 9 });
      bus.deliver(null, SCOPE, { v: 1, userId: me.id, type: "unread", unread: "9" });
      bus.deliver(null, SCOPE, { v: 1, userId: me.id, type: "count", count: { unread: 9 } });
    });
    await flush();
    expect(B.probe()).toBe(`true|1|${T1}`);
    act(() => bus.deliver(null, SCOPE, { v: 1, userId: me.id, type: "unread", unread: 250 }));
    await flush();
    expect(B.probe()).toBe(`true|100|${T1}`);
  });

  it("without Web Locks / BroadcastChannel every tab polls on its own (F007)", async () => {
    const A = mountTab({ coordinated: false, counts: [c(1, T1)] });
    await flush();
    const B = mountTab({ coordinated: false, counts: [c(1, T1)] });
    await flush();
    expect(A.count).toHaveBeenCalledTimes(1);
    expect(B.count).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(2);
    expect(B.count).toHaveBeenCalledTimes(2);
    expect(bus.sent).toHaveLength(0);
  });

  it("a single coordinated tab leads at once and polls like F007", async () => {
    const A = mountTab({ counts: [c(1, T1)] });
    await flush();
    expect(A.count).toHaveBeenCalledTimes(1);
    expect(A.probe()).toBe(`true|1|${T1}`);
    await advance(60_000);
    expect(A.count).toHaveBeenCalledTimes(2);
  });

  it("a 404 from the leader is shared: every bell hides", async () => {
    const { ApiError } = await import("../api/client");
    const { A, B } = await twoTabs({ counts: [new ApiError("not_found", "nope", 404)] });
    await flush();
    expect(A.probe()).toBe("false|0|null");
    expect(B.probe()).toBe("false|0|null");
    await advance(10 * 60_000);
    expect(A.count).toHaveBeenCalledTimes(1);
    expect(B.count).not.toHaveBeenCalled();
  });

  it("only the leader shows OS notifications; leadership hands the step over without duplicates", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const osA = { isEnabled: vi.fn(() => true), show: vi.fn(async () => {}) };
    const osB = { isEnabled: vi.fn(() => true), show: vi.fn(async () => {}) };
    const items2 = [notif({ id: "2", updatedAt: T2 })];
    const items3 = [notif({ id: "3", kind: "pinned", updatedAt: T3 }), ...items2];
    const { A, B } = await twoTabs({ os: osA, counts: [c(1, T1), c(2, T2)], list: items2 }, { os: osB, counts: [c(3, T3)], list: items3 });
    await advance(60_000);
    expect(osA.show).toHaveBeenCalledTimes(1);
    expect(osA.show).toHaveBeenCalledWith({ title: "Pixelforge Arcade", body: "Mia commented on Pixel Peaks" });
    expect(osB.show).not.toHaveBeenCalled();
    expect(B.list).not.toHaveBeenCalled();
    // The leader closes; B leads, polls on its cadence and shows only the newer notification.
    await advance(10_000);
    act(() => A.unmount());
    await flush();
    expect(B.count).not.toHaveBeenCalled();
    await advance(50_000);
    expect(B.count).toHaveBeenCalledTimes(1);
    await flush();
    expect(osB.show).toHaveBeenCalledTimes(1);
    expect(osB.show).toHaveBeenCalledWith({ title: "Pixelforge Arcade", body: "Mia pinned your comment on Pixel Peaks" });
    expect(osA.show).toHaveBeenCalledTimes(1);
  });

  it("signing out stops the tab and releases the lock; the next sign-in rejoins", async () => {
    const A = mountTab({ counts: [c(1, T1)] });
    await flush();
    expect(locks.holder(SCOPE + ".leader")).not.toBeNull();
    act(() => A.unmount());
    await flush();
    expect(locks.holder(SCOPE + ".leader")).toBeNull();
    expect(bus.channels.size).toBe(0);
  });
});
