import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER, SERVER_STORAGE_KEY, checkHealth, normalizeServerUrl, readSavedServer, saveServer } from "../server";

describe("normalizeServerUrl (decides where the auth token is sent)", () => {
  it.each([
    ["http://localhost:8080", "http://localhost:8080"],
    ["  https://arcade.example  ", "https://arcade.example"],
    ["https://arcade.example/", "https://arcade.example"],
    ["https://arcade.example///", "https://arcade.example"],
    ["https://arcade.example/api/v1/", "https://arcade.example/api/v1"],
    ["HTTPS://Arcade.Example:443/", "https://arcade.example"],
    ["http://arcade.example:80", "http://arcade.example"],
    ["localhost:8080", "http://localhost:8080"],
    ["arcade.example", "http://arcade.example"],
    ["192.168.1.5:8080/", "http://192.168.1.5:8080"],
    ["http://[::1]:8080", "http://[::1]:8080"],
    ["localhost:", "http://localhost"],
    ["arcade.example:8443/path", "http://arcade.example:8443/path"],
    ["https://arcade.example/a/../b", "https://arcade.example/b"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "javascript://%0aalert(1)",
    "JavaScript://arcade.example/%0aalert(1)",
    "file:///C:/Windows/win.ini",
    "file://server/share",
    "data:text/html,<script>alert(1)</script>",
    "ftp://arcade.example",
    "ws://arcade.example",
    "wss://arcade.example",
    "blob:https://arcade.example/uuid",
    "about:blank",
    // Used to become "http://b.c" / "http://evil.com": the scheme-like prefix was parsed as userinfo.
    "mailto:a@b.c",
    "javascript:alert(1)@evil.com",
    "file:C:/Windows/win.ini",
    // Credentials: the visible host is not where the token would go.
    "https://user:secret@arcade.example",
    "arcade.example@evil.com",
    "http://arcade.example:pw@evil.com",
    "tauri://localhost",
    "http://",
    "https://exa mple.com",
    "http://arcade.example?x=1",
    "http://arcade.example/#frag",
    "not a url at all",
    "http://:8080",
  ])("rejects %j", (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });

  it("never yields a trailing slash or a non-http(s) scheme", () => {
    for (const s of ["a.b/", "http://a.b//c//", "https://a.b:8443/x/"]) {
      const out = normalizeServerUrl(s)!;
      expect(out).toMatch(/^https?:\/\//);
      expect(out.endsWith("/")).toBe(false);
    }
  });

  it("has a valid default", () => {
    expect(normalizeServerUrl(DEFAULT_SERVER)).toBe(DEFAULT_SERVER);
  });
});

describe("saved server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is null on first run and round-trips through localStorage", () => {
    expect(readSavedServer()).toBeNull();
    saveServer("https://arcade.example");
    expect(localStorage.getItem(SERVER_STORAGE_KEY)).toBe("https://arcade.example");
    expect(readSavedServer()).toBe("https://arcade.example");
    saveServer(null);
    expect(localStorage.getItem(SERVER_STORAGE_KEY)).toBeNull();
    expect(readSavedServer()).toBeNull();
  });

  it("re-validates a tampered stored value", () => {
    localStorage.setItem(SERVER_STORAGE_KEY, "javascript:alert(1)");
    expect(readSavedServer()).toBeNull();
    localStorage.setItem(SERVER_STORAGE_KEY, "file:///etc/passwd");
    expect(readSavedServer()).toBeNull();
    localStorage.setItem(SERVER_STORAGE_KEY, "https://arcade.example/");
    expect(readSavedServer()).toBe("https://arcade.example");
  });

  it("survives unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readSavedServer()).toBeNull();
    expect(() => saveServer("https://arcade.example")).not.toThrow();
  });
});

describe("checkHealth", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async (_url: string, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

  it("accepts an ok health response", async () => {
    const fetchMock = respond(200, { status: "ok", version: "1.2.3" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkHealth("https://arcade.example")).resolves.toEqual({ ok: true, version: "1.2.3" });
    expect(fetchMock).toHaveBeenCalledWith("https://arcade.example/api/health", expect.objectContaining({ cache: "no-store" }));
  });

  it("reports HTTP errors, foreign servers and network failures", async () => {
    vi.stubGlobal("fetch", respond(503, ""));
    expect(await checkHealth("http://x")).toEqual({ ok: false, error: "Server answered HTTP 503" });
    vi.stubGlobal("fetch", respond(200, "<html>"));
    expect((await checkHealth("http://x")).ok).toBe(false);
    vi.stubGlobal("fetch", respond(200, { status: "nope" }));
    expect((await checkHealth("http://x")).ok).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const r = await checkHealth("http://x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Could not connect/);
  });

  it("times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ),
    );
    expect(await checkHealth("http://x", 10)).toEqual({ ok: false, error: "No answer within 0s" });
  });
});
