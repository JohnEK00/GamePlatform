import { describe, expect, it, vi } from "vitest";
import {
  createTabCoordinator,
  FOLLOWER_START_GRACE_MS,
  followerWatchdogMs,
  parseTabMessage,
  tabScope,
  VISIBLE_PING_MS,
  VISIBLE_TTL_MS,
  type ChannelLike,
  type LockManagerLike,
} from "../notificationsTabs";

describe("tabScope", () => {
  it("encodes the base URL and appends the user id", () => {
    expect(tabScope("https://api.example.com:8080/x?y=1", "u1")).toBe("webgame.notifications.https%3A%2F%2Fapi.example.com%3A8080%2Fx%3Fy%3D1.u1");
    expect(tabScope("", "u2")).toBe("webgame.notifications..u2");
    expect(tabScope("http://a", "u1")).not.toBe(tabScope("http://b", "u1"));
  });
});

describe("constants", () => {
  it("match the spec", () => {
    expect(VISIBLE_TTL_MS).toBe(75_000);
    expect(VISIBLE_PING_MS).toBe(30_000);
    expect(FOLLOWER_START_GRACE_MS).toBe(5_000);
  });
  it("followerWatchdogMs = max(3 × pollAfterSecs, 180) s, with F007 normalisation", () => {
    expect(followerWatchdogMs(60)).toBe(180_000);
    expect(followerWatchdogMs(15)).toBe(180_000);
    expect(followerWatchdogMs(100)).toBe(300_000);
    expect(followerWatchdogMs(600)).toBe(1_800_000);
    expect(followerWatchdogMs(99_999)).toBe(1_800_000); // clamped to 600 s
    expect(followerWatchdogMs(undefined)).toBe(180_000); // default 60
    expect(followerWatchdogMs(Number.NaN)).toBe(180_000);
  });
});

describe("parseTabMessage", () => {
  const env = { v: 1, userId: "u1" };
  it("accepts every type for the right user", () => {
    expect(parseTabMessage({ ...env, type: "count", count: { unread: 3, latestAt: "2026-11-15T10:00:00.000Z", pollAfterSecs: 30 } }, "u1")).toEqual({
      ...env,
      type: "count",
      count: { unread: 3, latestAt: "2026-11-15T10:00:00.000Z", pollAfterSecs: 30 },
    });
    expect(parseTabMessage({ ...env, type: "count", count: { unread: 0, latestAt: null, pollAfterSecs: 60 } }, "u1")?.type).toBe("count");
    expect(parseTabMessage({ ...env, type: "unread", unread: 4 }, "u1")).toEqual({ ...env, type: "unread", unread: 4 });
    for (const type of ["poll", "visible", "unsupported"]) expect(parseTabMessage({ ...env, type, extra: "dropped" }, "u1")).toEqual({ ...env, type });
  });

  it("rejects a wrong version, another user and junk", () => {
    expect(parseTabMessage({ v: 2, userId: "u1", type: "poll" }, "u1")).toBeNull();
    expect(parseTabMessage({ userId: "u1", type: "poll" }, "u1")).toBeNull();
    expect(parseTabMessage({ v: 1, userId: "u2", type: "poll" }, "u1")).toBeNull();
    expect(parseTabMessage({ v: 1, type: "poll" }, "u1")).toBeNull();
    expect(parseTabMessage({ v: 1, userId: "", type: "poll" }, "")).toBeNull();
    expect(parseTabMessage(null, "u1")).toBeNull();
    expect(parseTabMessage("poll", "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "token", token: "secret" }, "u1")).toBeNull();
  });

  it("rejects bad shapes", () => {
    expect(parseTabMessage({ ...env, type: "count" }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "count", count: { unread: "3", latestAt: null } }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "count", count: { unread: Number.NaN, latestAt: null } }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "count", count: { unread: 1, latestAt: 5 } }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "count", count: { unread: 1, latestAt: "not a date" } }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "unread" }, "u1")).toBeNull();
    expect(parseTabMessage({ ...env, type: "unread", unread: Infinity }, "u1")).toBeNull();
  });

  it("clamps counts like F007 and normalises pollAfterSecs", () => {
    const m = parseTabMessage({ ...env, type: "count", count: { unread: 250.7, latestAt: null, pollAfterSecs: 1 } }, "u1");
    expect(m).toEqual({ ...env, type: "count", count: { unread: 100, latestAt: null, pollAfterSecs: 15 } });
    expect(parseTabMessage({ ...env, type: "count", count: { unread: -3, latestAt: null } }, "u1")).toMatchObject({ count: { unread: 0, pollAfterSecs: 60 } });
    expect(parseTabMessage({ ...env, type: "unread", unread: 3.9 }, "u1")).toMatchObject({ unread: 3 });
    expect(parseTabMessage({ ...env, type: "unread", unread: 1000 }, "u1")).toMatchObject({ unread: 100 });
  });
});

describe("createTabCoordinator", () => {
  it("returns null without Web Locks or a channel", () => {
    const locks: LockManagerLike = { request: vi.fn(async () => undefined) };
    expect(createTabCoordinator({ locks: null, createChannel: () => null })).toBeNull();
    expect(createTabCoordinator({ locks, createChannel: null })).toBeNull();
    expect(createTabCoordinator({ locks: null })).toBeNull();
    // jsdom has BroadcastChannel but no navigator.locks: the default is "unsupported".
    expect(createTabCoordinator({})).toBeNull();
    // join() returns null when the channel can not be created.
    expect(createTabCoordinator({ locks, createChannel: () => null })!.join("http://a", "u1", { onLeader() {}, onMessage() {} })).toBeNull();
  });

  it("requests the scope's lock with a signal, posts with the envelope, and stop() aborts, releases and closes", async () => {
    let held: Promise<unknown> | null = null;
    let signal: AbortSignal | undefined;
    const request = vi.fn((name: string, opts: { signal?: AbortSignal }, cb: (l: unknown) => unknown) => {
      signal = opts.signal;
      held = Promise.resolve(cb({ name }));
      return held;
    });
    const locks: LockManagerLike = { request };
    const sent: unknown[] = [];
    const channel: ChannelLike = { onmessage: null, postMessage: (m) => sent.push(m), close: vi.fn() };
    const onLeader = vi.fn();
    const onMessage = vi.fn();
    const session = createTabCoordinator({ locks, createChannel: () => channel })!.join("http://a", "u1", { onLeader, onMessage })!;
    expect(session.scope).toBe(tabScope("http://a", "u1"));
    expect(request.mock.calls[0][0]).toBe(tabScope("http://a", "u1") + ".leader");
    expect(onLeader).toHaveBeenCalledTimes(1);
    expect(session.isLeader()).toBe(true);
    session.post({ type: "unread", unread: 2 });
    expect(sent).toEqual([{ v: 1, userId: "u1", type: "unread", unread: 2 }]);
    // Incoming messages are validated and filtered by user.
    channel.onmessage!({ data: { v: 1, userId: "u2", type: "poll" } });
    channel.onmessage!({ data: { v: 1, userId: "u1", type: "poll" } });
    expect(onMessage).toHaveBeenCalledTimes(1);
    let released = false;
    void held!.then(() => (released = true));
    session.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(channel.close).toHaveBeenCalled();
    expect(session.isLeader()).toBe(false);
    session.post({ type: "poll" });
    expect(sent).toHaveLength(1);
  });

  it("swallows the AbortError of a queued request", async () => {
    const locks: LockManagerLike = {
      request: (_n, opts) =>
        new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    };
    const channel: ChannelLike = { onmessage: null, postMessage() {}, close() {} };
    const onLeader = vi.fn();
    const session = createTabCoordinator({ locks, createChannel: () => channel })!.join("http://a", "u1", { onLeader, onMessage() {} })!;
    session.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(onLeader).not.toHaveBeenCalled();
  });
});
