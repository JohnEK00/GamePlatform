/**
 * Guards the parts of src-tauri/tauri.conf.json that F016 (synced control bindings, gamepad capture in the
 * parent page) relies on. The UI talks to the user-configured server, so the CSP must allow any http(s) origin,
 * not a fixed host. `fetch(..., { keepalive: true })` is governed by the same `connect-src` directive.
 */
import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

interface TauriConf {
  app: {
    windows: Array<Record<string, unknown>>;
    security: { csp: Record<string, string>; headers?: Record<string, unknown> };
  };
}

const conf = JSON.parse(confRaw) as TauriConf;
const csp = conf.app.security.csp;

function sources(directive: string): string[] {
  return (csp[directive] ?? "").split(/\s+/).filter(Boolean);
}

/** CSP Level 3 source matching, reduced to the source forms this config uses (scheme sources and host[:port|:*]). */
function allows(directive: string, url: string): boolean {
  const u = new URL(url);
  return sources(directive).some((src) => {
    if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) {
      // A scheme source; "http:" also matches https (CSP3 upgrade rule).
      return u.protocol === src || (src === "http:" && u.protocol === "https:");
    }
    const m = /^(https?):\/\/([^/:]+)(?::(\d+|\*))?$/.exec(src);
    if (!m) return false;
    if (`${m[1]}:` !== u.protocol || m[2] !== u.hostname) return false;
    return m[3] === "*" || (m[3] ?? "") === u.port;
  });
}

describe("tauri.conf.json CSP (F016 controls sync)", () => {
  const servers = [
    "http://localhost:8080",
    "http://127.0.0.1:9000",
    "https://arcade.example",
    "http://192.168.1.5:8080",
    "arcade.example:8443/sub",
  ];

  it.each(servers)("connect-src allows GET/PUT {server}/api/games/{id}/controls for %s", (input) => {
    const server = normalizeServerUrl(input);
    expect(server).not.toBeNull();
    expect(allows("connect-src", `${server}/api/games/g_123/controls`)).toBe(true);
  });

  // F020: PUT {server}/api/games/{id}/comment-settings (CSP has no per-method rules; connect-src covers PUT).
  it.each(servers)("connect-src allows PUT {server}/api/games/{id}/comment-settings for %s (F020)", (input) => {
    const server = normalizeServerUrl(input);
    expect(allows("connect-src", `${server}/api/games/g_123/comment-settings`)).toBe(true);
    expect(allows("connect-src", `${server}/api/games/g_123/comments?sort=top`)).toBe(true);
  });

  it.each(servers)("frame-src allows game iframes served by %s", (input) => {
    expect(allows("frame-src", `${normalizeServerUrl(input)}/play/g_123/`)).toBe(true);
  });

  it("does not fall back to default-src for connections (which would block the server)", () => {
    expect(csp["connect-src"]).toBeTruthy();
    expect(allows("default-src", "https://arcade.example/api/health")).toBe(false);
  });
});

describe("tauri.conf.json leaves the Gamepad API usable in the top-level page (F016)", () => {
  it("sets no Permissions-Policy / Feature-Policy header", () => {
    const names = Object.keys(conf.app.security.headers ?? {}).map((k) => k.toLowerCase());
    expect(names).not.toContain("permissions-policy");
    expect(names).not.toContain("feature-policy");
  });

  it("passes no WebView2 browser arguments that disable gamepads", () => {
    for (const w of conf.app.windows) {
      const args = typeof w.additionalBrowserArgs === "string" ? w.additionalBrowserArgs : "";
      expect(args.toLowerCase()).not.toContain("gamepad");
    }
  });
});
