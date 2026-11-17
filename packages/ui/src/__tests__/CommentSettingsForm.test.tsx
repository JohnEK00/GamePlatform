import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { CommentSettings } from "../api/types";
import { CommentSettingsForm } from "../components/CommentSettingsForm";
import { WebGameProviders } from "../WebGameApp";

function makeClient() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  return new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
}

function setup(value: CommentSettings, opts: { onCancel?: () => void } = {}) {
  const client = makeClient();
  const onSaved = vi.fn();
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <h2 id="hd">Comments</h2>
        <CommentSettingsForm gameId="g1" value={value} onSaved={onSaved} onCancel={opts.onCancel} headingId="hd" />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { client, onSaved, ...utils };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

const saveBtn = () => screen.getByRole("button", { name: /Save comment settings/ }) as HTMLButtonElement;

describe("CommentSettingsForm (F020 § 2.1)", () => {
  it("labels, legend, hints and options in order", () => {
    setup({ mode: "on", slowModeSecs: 0 });
    expect(screen.getByRole("form", { name: "Comments" })).toBeTruthy();
    const group = screen.getByRole("group", { name: "Who can comment" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")!.textContent).toBe("Who can comment");
    const hintId = group.getAttribute("aria-describedby")!;
    expect(document.getElementById(hintId)!.textContent).toBe("Existing comments stay visible. You and moderators can always post.");

    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["on", "repliesOnly", "off"]);
    expect(radios.map((r) => r.name)).toEqual(["pf-comment-mode", "pf-comment-mode", "pf-comment-mode"]);
    expect(radios.map((r) => (r.closest("label") as HTMLElement).textContent)).toEqual([
      "Everyone can comment",
      "Replies only: no new threads",
      "Off: no new comments or replies",
    ]);
    expect(screen.getByRole("radio", { name: "Everyone can comment" })).toHaveProperty("checked", true);

    const select = screen.getByLabelText("Slow mode") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.id).toBe("pf-slow-mode");
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["0", "Off"],
      ["30", "30 seconds"],
      ["60", "1 minute"],
      ["300", "5 minutes"],
      ["900", "15 minutes"],
      ["3600", "1 hour"],
    ]);
    expect(select.value).toBe("0");
    expect(document.getElementById(select.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Each player can post one comment or reply on this game per interval.",
    );
  });

  it("starts from the value; Save is disabled until something changed (and again when changed back)", () => {
    setup({ mode: "repliesOnly", slowModeSecs: 300 });
    expect(screen.getByRole("radio", { name: "Replies only: no new threads" })).toHaveProperty("checked", true);
    expect((screen.getByLabelText("Slow mode") as HTMLSelectElement).value).toBe("300");
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Off: no new comments or replies" }));
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Replies only: no new threads" }));
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Slow mode"), { target: { value: "60" } });
    expect(saveBtn().disabled).toBe(false);
  });

  it("saves both fields, disables Save while saving, toasts and calls onSaved with the response", async () => {
    const { client, onSaved } = setup({ mode: "on", slowModeSecs: 0 });
    const d = deferred<CommentSettings>();
    const put = vi.spyOn(client, "updateCommentSettings").mockReturnValue(d.promise);
    fireEvent.click(screen.getByRole("radio", { name: "Off: no new comments or replies" }));
    fireEvent.change(screen.getByLabelText("Slow mode"), { target: { value: "900" } });
    fireEvent.click(saveBtn());
    expect(put).toHaveBeenCalledWith("g1", { mode: "off", slowModeSecs: 900 });
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByRole("form").getAttribute("aria-busy")).toBe("true");
    await act(async () => d.resolve({ mode: "off", slowModeSecs: 900 }));
    expect(onSaved).toHaveBeenCalledWith({ mode: "off", slowModeSecs: 900 });
    expect(await screen.findByText("Comment settings saved")).toBeTruthy();
  });

  it("a 422 shows the server message inline and keeps the values", async () => {
    const { client, onSaved } = setup({ mode: "on", slowModeSecs: 0 });
    vi.spyOn(client, "updateCommentSettings").mockRejectedValue(
      new ApiError("validation", "slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600", 422),
    );
    fireEvent.change(screen.getByLabelText("Slow mode"), { target: { value: "30" } });
    await act(async () => fireEvent.click(saveBtn()));
    expect(screen.getByRole("alert").textContent).toBe("slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600");
    expect((screen.getByLabelText("Slow mode") as HTMLSelectElement).value).toBe("30");
    expect(saveBtn().disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a 429 shows the rate-limit message inline", async () => {
    const { client } = setup({ mode: "on", slowModeSecs: 0 });
    vi.spyOn(client, "updateCommentSettings").mockRejectedValue(ApiError.fromResponse(429, null, "", "12"));
    fireEvent.click(screen.getByRole("radio", { name: "Replies only: no new threads" }));
    await act(async () => fireEvent.click(saveBtn()));
    expect(screen.getByRole("alert").textContent).toBe("Slow down, try again in 12s.");
    expect(screen.getByRole("radio", { name: "Replies only: no new threads" })).toHaveProperty("checked", true);
  });

  it("dialog variant: Cancel + Save", () => {
    const onCancel = vi.fn();
    setup({ mode: "on", slowModeSecs: 0 }, { onCancel });
    expect(screen.queryByRole("button", { name: /Save comment settings/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
