/**
 * Desktop-only components (review 9 L8): the offline banner, the server URL form and the OS-notification switch.
 * `fetch` (the /api/health check) and the Tauri `invoke` are mocked; nothing reaches a server or the OS.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));

import { OfflineBanner } from "../OfflineBanner";
import { OsNotificationSetting } from "../OsNotificationSetting";
import { ServerContext, type ServerState } from "../ServerContext";
import { ServerForm } from "../ServerForm";
import { DEFAULT_SERVER } from "../server";
import { OS_NOTIFICATIONS_KEY } from "../platform";

const SERVER = "http://192.168.1.5:8080";

let root: Root | null = null;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

/** Health answers, in order (the last one repeats): true = a Pixelforge server, false = connection refused. */
function healthAnswers(...answers: Array<boolean | { version: string }>) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a === false) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ status: "ok", version: a === true ? undefined : a.version }), { status: 200 });
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function render(node: ReactNode) {
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  await flush();
}

function withServer(node: ReactNode, state: Partial<ServerState> = {}) {
  const value: ServerState = { server: SERVER, isDefault: false, setServer: vi.fn(), ...state };
  return { value, node: <ServerContext.Provider value={value}>{node}</ServerContext.Provider> };
}

function button(name: string | RegExp): HTMLButtonElement {
  const b = [...host.querySelectorAll("button")].find((el) => {
    const label = el.getAttribute("aria-label") ?? el.textContent ?? "";
    return typeof name === "string" ? label.trim() === name : name.test(label);
  });
  if (!b) throw new Error(`no button ${name}; have: ${[...host.querySelectorAll("button")].map((x) => x.textContent).join(", ")}`);
  return b;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(".pfd-server-form input")!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  m.isTauri.mockImplementation(() => true);
  m.invoke.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OfflineBanner", () => {
  it("renders nothing while the server answers", async () => {
    healthAnswers(true);
    await render(withServer(<OfflineBanner />).node);
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/api/health`, expect.objectContaining({ cache: "no-store" }));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("welcomes first-run users on the default server and explains how to start the backend", async () => {
    healthAnswers(false);
    await render(withServer(<OfflineBanner />, { server: DEFAULT_SERVER, isDefault: true }).node);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Welcome to Pixelforge Arcade! Can’t reach the game server.");
    expect(alert.querySelector("code")!.textContent).toBe(DEFAULT_SERVER);
    expect(alert.textContent).toContain("Could not connect");
    expect(alert.textContent).toContain("npm run dev:backend");
  });

  it("names a custom server without the welcome", async () => {
    healthAnswers(false);
    await render(withServer(<OfflineBanner />).node);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).not.toContain("Welcome");
    expect(alert.querySelector("code")!.textContent).toBe(SERVER);
    expect(alert.textContent).toContain("Check that the server is running");
  });

  it("polls every 10 s while offline and disappears once the server is back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    healthAnswers(false, false, true);
    await render(withServer(<OfflineBanner />).node);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    // Online: no more polling.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Retry checks again at once", async () => {
    healthAnswers(false, true);
    await render(withServer(<OfflineBanner />).node);
    await click(button("Retry"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("Change server toggles the server form, and Dismiss hides the banner", async () => {
    healthAnswers(false);
    await render(withServer(<OfflineBanner />).node);
    const toggle = button("Change server");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".pfd-server-form")).toBeNull();

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Close");
    expect(input().value).toBe(SERVER);
    // Compact form: no description, no "Reset to default".
    expect(host.querySelector(".pfd-server-form .pf-muted")).toBeNull();
    expect(() => button("Reset to default")).toThrow();

    await click(toggle);
    expect(host.querySelector(".pfd-server-form")).toBeNull();

    await click(button("Dismiss"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("ServerForm", () => {
  it("shows the current server, and Save stays disabled until it changes", async () => {
    await render(withServer(<ServerForm />).node);
    const field = input();
    expect(field.value).toBe(SERVER);
    const label = host.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`)!;
    expect(label.textContent).toBe("API server URL");
    expect(host.querySelector(".pf-muted")!.textContent).toContain(`Current: ${SERVER}.`);
    expect(button("Save").disabled).toBe(true);
    expect(button("Test connection").disabled).toBe(false);
  });

  it("rejects non-http addresses and disables both actions", async () => {
    await render(withServer(<ServerForm />).node);
    for (const bad of ["javascript:alert(1)", "ftp://example.com", "http://user:pw@example.com"]) {
      await type(input(), bad);
      expect(input().getAttribute("aria-invalid"), bad).toBe("true");
      expect(host.querySelector(".pf-alert--error")!.textContent).toContain("Enter an http:// or https:// address");
      expect(button("Save").disabled).toBe(true);
      expect(button("Test connection").disabled).toBe(true);
    }
    await type(input(), "");
    expect(input().hasAttribute("aria-invalid")).toBe(false);
    expect(host.querySelector(".pf-alert--error")).toBeNull();
    expect(button("Save").disabled).toBe(true);
  });

  it("saves the normalized URL (which re-mounts the app against it)", async () => {
    const { value, node } = withServer(<ServerForm />);
    await render(node);
    await type(input(), "  192.168.1.9:8080/ ");
    expect(input().hasAttribute("aria-invalid")).toBe(false);
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    expect(value.setServer).toHaveBeenCalledWith("http://192.168.1.9:8080");
  });

  it("a first-run user can save the default server to keep it", async () => {
    const { value, node } = withServer(<ServerForm />, { server: DEFAULT_SERVER, isDefault: true });
    await render(node);
    expect(host.querySelector(".pf-muted")!.textContent).toContain("(default)");
    expect(() => button("Reset to default")).toThrow();
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    expect(value.setServer).toHaveBeenCalledWith(DEFAULT_SERVER);
  });

  it("Reset to default clears the saved server", async () => {
    const { value, node } = withServer(<ServerForm />);
    await render(node);
    await click(button("Reset to default"));
    expect(value.setServer).toHaveBeenCalledWith(null);
  });

  it("Test connection checks the typed server and reports the result", async () => {
    healthAnswers({ version: "1.4.0" }, false);
    const { value, node } = withServer(<ServerForm />);
    await render(node);
    await type(input(), "https://arcade.example/");
    await click(button("Test connection"));
    expect(fetchMock).toHaveBeenLastCalledWith("https://arcade.example/api/health", expect.anything());
    expect(host.querySelector('.pf-alert--success[role="status"]')!.textContent).toBe(
      "Connected to https://arcade.example (server v1.4.0).",
    );

    await click(button("Test connection"));
    const err = host.querySelector('.pf-alert--error[role="status"]')!;
    expect(err.textContent).toContain("https://arcade.example: Could not connect");
    // Testing doesn't save, and editing clears the result.
    expect(value.setServer).not.toHaveBeenCalled();
    await type(input(), "https://arcade.example/x");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe("OsNotificationSetting", () => {
  function status(s: string, request?: () => Promise<unknown>) {
    m.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "os_notifications_status") return s;
      if (cmd === "request_os_notifications") return request ? request() : "granted";
      throw new Error(`unexpected ${cmd}`);
    });
  }

  function checkbox(): HTMLInputElement | null {
    return host.querySelector<HTMLInputElement>('.pfd-os-notifications input[type="checkbox"]');
  }

  it("renders nothing in a plain browser", async () => {
    m.isTauri.mockImplementation(() => false);
    await render(<OsNotificationSetting />);
    expect(host.innerHTML).toBe("");
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("renders nothing when the app was built without OS notifications", async () => {
    status("unsupported");
    await render(<OsNotificationSetting />);
    expect(m.invoke).toHaveBeenCalledWith("os_notifications_status");
    expect(host.innerHTML).toBe("");
  });

  it("is off by default and labelled", async () => {
    status("prompt");
    await render(<OsNotificationSetting />);
    const cb = checkbox()!;
    expect(cb.checked).toBe(false);
    expect(document.getElementById(cb.getAttribute("aria-labelledby")!)!.textContent).toBe("Show desktop notifications");
    expect(document.getElementById(cb.getAttribute("aria-describedby")!)!.textContent).toContain("Comment text is never shown");
  });

  it("turning it on asks the OS and stores the opt-in when granted", async () => {
    let grant!: (v: string) => void;
    status("prompt", () => new Promise((r) => (grant = r)));
    await render(<OsNotificationSetting />);
    await click(checkbox()!);
    expect(m.invoke).toHaveBeenCalledWith("request_os_notifications");
    expect(checkbox()!.disabled).toBe(true);

    await act(async () => grant("granted"));
    await flush();
    expect(checkbox()!.disabled).toBe(false);
    expect(checkbox()!.checked).toBe(true);
    expect(localStorage.getItem(OS_NOTIFICATIONS_KEY)).toBe("1");
  });

  it("stays off and says so when the OS blocks notifications", async () => {
    status("prompt", async () => "denied");
    await render(<OsNotificationSetting />);
    await click(checkbox()!);
    expect(checkbox()!.checked).toBe(false);
    expect(localStorage.getItem(OS_NOTIFICATIONS_KEY)).toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Notifications are blocked in your system settings.");
  });

  it("restores a saved opt-in and turns off without asking the OS", async () => {
    localStorage.setItem(OS_NOTIFICATIONS_KEY, "1");
    status("granted");
    await render(<OsNotificationSetting />);
    expect(checkbox()!.checked).toBe(true);
    await click(checkbox()!);
    expect(checkbox()!.checked).toBe(false);
    expect(localStorage.getItem(OS_NOTIFICATIONS_KEY)).toBeNull();
    expect(m.invoke).not.toHaveBeenCalledWith("request_os_notifications");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
  });
});
