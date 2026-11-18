import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { User } from "../api/types";

const user: User = {
  id: "u1",
  username: "mia",
  displayName: "Mia",
  avatarUrl: null,
  bio: "",
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
  bannerUrl: "/media/banners/u1.jpg?v=1",
  links: [{ label: "Site", url: "https://mia.dev" }],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient() {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, user));
  const client = new ApiClient({ baseUrl: "http://api.test/", fetch: fetchMock as unknown as typeof fetch });
  return { client, fetchMock };
}

/** Minimal XMLHttpRequest stand-in capturing what `upload` sends. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = "";
  url = "";
  body: unknown = null;
  status = 200;
  responseText = JSON.stringify(user);
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader() {
    return "application/json";
  }
  getAllResponseHeaders() {
    return "content-type: application/json\r\n";
  }
  abort() {}
  send(body: unknown) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    setTimeout(() => this.onload?.(), 0);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.last = null;
});

describe("ApiClient F028", () => {
  it("uploadBanner PUTs multipart field `banner` to /api/users/me/banner with progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
    const { client } = makeClient();
    const progress = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], "wide.png", { type: "image/png" });
    const res = await client.uploadBanner(file, progress);
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("http://api.test/api/users/me/banner");
    expect(xhr.body).toBeInstanceOf(FormData);
    const sent = (xhr.body as FormData).get("banner");
    expect(sent).toBeInstanceOf(Blob);
    expect((sent as File).name).toBe("wide.png");
    expect(progress).toHaveBeenCalled();
    expect(res.bannerUrl).toBe("/media/banners/u1.jpg?v=1");
  });

  it("deleteBanner sends DELETE /api/users/me/banner and returns the User", async () => {
    const { client, fetchMock } = makeClient();
    const res = await client.deleteBanner();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://api.test/api/users/me/banner");
    expect(init?.method).toBe("DELETE");
    expect(res.username).toBe("mia");
  });

  it("updateMe passes links through in the PATCH body", async () => {
    const { client, fetchMock } = makeClient();
    await client.updateMe({ displayName: "Mia", bio: "", links: [{ label: "", url: "https://www.example.com/me" }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://api.test/api/users/me");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: "Mia", bio: "", links: [{ label: "", url: "https://www.example.com/me" }] });
  });

  it("updateMe with links [] clears them (the key is sent)", async () => {
    const { client, fetchMock } = makeClient();
    await client.updateMe({ links: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ links: [] });
  });
});
