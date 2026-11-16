import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, body));
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body, headers: init?.headers as Record<string, string> };
  };
  return { client, fetchMock, call };
}

type Sent = { method: string; url: string; form: FormData };

/** Fake XHR that records the multipart body and answers 200 with `{ version: 5 }`. */
function installFakeXhr() {
  const sent: Sent[] = [];
  class FakeXHR {
    status = 200;
    statusText = "OK";
    responseText = JSON.stringify({ id: "g1", version: 5 });
    upload = { onprogress: null as unknown };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = "";
    private url = "";
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return null;
    }
    send(form: FormData) {
      sent.push({ method: this.method, url: this.url, form });
      setTimeout(() => this.onload?.(), 0);
    }
  }
  const orig = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  return { sent, restore: () => (globalThis.XMLHttpRequest = orig) };
}

let restoreXhr: (() => void) | null = null;
afterEach(() => {
  restoreXhr?.();
  restoreXhr = null;
});

const zip = () => new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: "application/zip" });

describe("ApiClient F004: replaceBundle", () => {
  it("keeps the 3-argument call working (no notes, no expectedVersion)", async () => {
    const x = installFakeXhr();
    restoreXhr = x.restore;
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const g = await client.replaceBundle("g1", zip(), () => {});
    expect(g.version).toBe(5);
    expect(x.sent[0].method).toBe("PUT");
    expect(x.sent[0].url).toBe("http://api.test/api/games/g1/bundle");
    expect(x.sent[0].form.get("bundle")).toBeInstanceOf(Blob);
    expect(x.sent[0].form.has("notes")).toBe(false);
    expect(x.sent[0].form.has("expectedVersion")).toBe(false);
  });

  it("appends notes when non-empty and expectedVersion as a decimal string", async () => {
    const x = installFakeXhr();
    restoreXhr = x.restore;
    const client = new ApiClient({ baseUrl: "http://api.test" });
    await client.replaceBundle("g1", zip(), undefined, { notes: "Added 3 levels\nFixed jump", expectedVersion: 4 });
    const f = x.sent[0].form;
    expect(f.get("notes")).toBe("Added 3 levels\nFixed jump");
    expect(f.get("expectedVersion")).toBe("4");
  });

  it("omits blank notes (empty or whitespace only) but still sends expectedVersion", async () => {
    const x = installFakeXhr();
    restoreXhr = x.restore;
    const client = new ApiClient({ baseUrl: "http://api.test" });
    await client.replaceBundle("g1", zip(), undefined, { notes: "  \n\t ", expectedVersion: 12 });
    await client.replaceBundle("g1", zip(), undefined, { notes: "" });
    expect(x.sent[0].form.has("notes")).toBe(false);
    expect(x.sent[0].form.get("expectedVersion")).toBe("12");
    expect(x.sent[1].form.has("notes")).toBe(false);
    expect(x.sent[1].form.has("expectedVersion")).toBe(false);
  });

  it("encodes the id in the path", async () => {
    const x = installFakeXhr();
    restoreXhr = x.restore;
    const client = new ApiClient({ baseUrl: "http://api.test" });
    await client.replaceBundle("a b/c?", zip(), undefined, { expectedVersion: 1 });
    expect(x.sent[0].url).toBe("http://api.test/api/games/a%20b%2Fc%3F/bundle");
  });
});

describe("ApiClient F004: createGame notes", () => {
  it("appends notes only when non-empty after trim", async () => {
    const x = installFakeXhr();
    restoreXhr = x.restore;
    const client = new ApiClient({ baseUrl: "http://api.test" });
    await client.createGame({ title: "T", bundle: zip(), notes: "First release" });
    await client.createGame({ title: "T", bundle: zip(), notes: "   " });
    await client.createGame({ title: "T", bundle: zip() });
    expect(x.sent[0].url).toBe("http://api.test/api/games");
    expect(x.sent[0].form.get("notes")).toBe("First release");
    expect(x.sent[1].form.has("notes")).toBe(false);
    expect(x.sent[2].form.has("notes")).toBe(false);
  });
});

describe("ApiClient F004: version history", () => {
  it("listGameVersions builds the path and paging query", async () => {
    const page = { items: [{ version: 2, notes: "x", createdAt: "2026-01-01T00:00:00Z", current: true }], total: 1, page: 1, perPage: 20 };
    const { client, call } = makeClient(page);
    expect(await client.listGameVersions("g1")).toEqual(page);
    await client.listGameVersions("g1", { page: 2, perPage: 20 });
    await client.listGameVersions("a b/c?", { page: 3 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/versions", method: "GET" });
    const u1 = new URL(call(1).url);
    expect(u1.pathname).toBe("/api/games/g1/versions");
    expect(u1.searchParams.get("page")).toBe("2");
    expect(u1.searchParams.get("perPage")).toBe("20");
    expect(call(2).url).toBe("http://api.test/api/games/a%20b%2Fc%3F/versions?page=3");
  });

  it("updateVersionNotes PATCHes JSON { notes } to the version path", async () => {
    const row = { version: 3, notes: "Fixed", createdAt: "2026-01-01T00:00:00Z", current: false };
    const { client, call } = makeClient(row);
    expect(await client.updateVersionNotes("g 1", 3, "Fixed")).toEqual(row);
    const c = call(0);
    expect(c.url).toBe("http://api.test/api/games/g%201/versions/3");
    expect(c.method).toBe("PATCH");
    expect(JSON.parse(String(c.body))).toEqual({ notes: "Fixed" });
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.headers.Authorization).toBe("Bearer tok");
  });

  it("updateVersionNotes sends an empty string to clear a note", async () => {
    const { client, call } = makeClient({ version: 1, notes: "", createdAt: "", current: true });
    await client.updateVersionNotes("g1", 1, "");
    expect(JSON.parse(String(call(0).body))).toEqual({ notes: "" });
  });
});
