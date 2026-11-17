import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Comment, CommentListPage, CommentSettings, CommentSettingsView, CommentThread, User, UserRef } from "../api/types";
import { Comments } from "../components/Comments";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const alice: UserRef = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function cm(id: string, over: Partial<Comment> = {}): Comment {
  return {
    id,
    gameId: "g1",
    author: alice,
    body: `Body ${id}`,
    createdAt: "2026-11-15T10:00:00Z",
    parentId: null,
    replyTo: null,
    isCreator: false,
    hearts: 0,
    myHeart: false,
    creatorHeart: false,
    canDelete: false,
    pinned: false,
    locked: false,
    canModerate: false,
    ...over,
  };
}
function th(id: string, over: Partial<Comment> = {}): CommentThread {
  return { ...cm(id, over), replies: [], replyCount: 0 };
}
function view(over: Partial<CommentSettingsView> = {}): CommentSettingsView {
  return { mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0, ...over };
}
function listPage(items: CommentThread[], settings: CommentSettingsView | undefined = view()): CommentListPage {
  const p = { items, total: items.length, totalAll: items.length, page: 1, perPage: 20, pinned: null } as Omit<CommentListPage, "settings">;
  return (settings ? { ...p, settings } : p) as CommentListPage;
}

const CLOSED_A = "New comments are turned off for this game.";
const CLOSED_B = "Comments are turned off for this game.";
const M_A = "New comments are turned off for players. Only you and moderators can start threads.";
const M_B = "Comments are turned off for players. Only you and moderators can post.";

/** Lets every pending promise settle (works with real and fake timers; no waitFor polling). */
async function flush(n = 6) {
  for (let i = 0; i < n; i++) await act(async () => {});
}

type Setup = { signedIn?: boolean; threads?: CommentThread[]; settings?: CommentSettingsView | undefined; mocks?: (c: ApiClient) => void };

async function setup({ signedIn = true, threads = [th("c1")], settings = view(), mocks }: Setup = {}) {
  if (signedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({
    baseUrl: "http://api.test",
    fetch: (async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 })) as unknown as typeof fetch,
  });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "listComments").mockResolvedValue(listPage(threads, settings));
  mocks?.(client);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/games/g1"]}>
        <Comments gameId="g1" />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await flush();
  return { client, ...utils };
}

const liveText = () => document.querySelector(".pf-panel > [role=status]")!.textContent;
const liveSpan = () => document.querySelector(".pf-panel > [role=status] > span");
const closedNote = () => document.getElementById("pf-comments-closed");
const topInput = () => document.getElementById("pf-comment-body") as HTMLTextAreaElement | null;
const submitOf = (input: HTMLElement) => input.closest("form")!.querySelector("button[type=submit]") as HTMLButtonElement;
/** The form notice's text without its decorative icon. */
function noticeText(inputId: string): string | null {
  const el = document.getElementById(`${inputId}-notice`);
  if (!el) return null;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[aria-hidden=true]").forEach((x) => x.remove());
  return (copy.textContent ?? "").trim();
}
const badges = () => Array.from(document.querySelectorAll(".pf-comments__badges .pf-badge")).map((b) => [b.textContent, b.className]);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Comments F020 § 2.4: the top-level slot", () => {
  it("anonymous · on: the unchanged Log in line", async () => {
    await setup({ signedIn: false });
    const p = screen.getByText(/to join the conversation\./).closest("p")!;
    expect(p.textContent).toBe("Log in to join the conversation.");
    expect(closedNote()).toBeNull();
    expect(topInput()).toBeNull();
  });

  it("anonymous · repliesOnly: note A + Log in to reply", async () => {
    await setup({ signedIn: false, settings: view({ mode: "repliesOnly" }) });
    const note = closedNote()!;
    expect(note.tagName).toBe("P");
    expect(note.className).toBe("pf-comments__closed pf-muted");
    expect(note.getAttribute("tabindex")).toBe("-1");
    expect(note.textContent).toBe("New comments are turned off for this game. Log in to reply to existing threads.");
    const link = within(note).getByRole("link", { name: "Log in" });
    expect(link.getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/games/g1")}`);
    expect(topInput()).toBeNull();
  });

  it("anonymous · off: note B only", async () => {
    await setup({ signedIn: false, settings: view({ mode: "off" }) });
    expect(closedNote()!.textContent).toBe(CLOSED_B);
    expect(within(closedNote()!).queryByRole("link")).toBeNull();
    expect(screen.queryByText(/to join the conversation/)).toBeNull();
    expect(topInput()).toBeNull();
  });

  it("signed in · on: the form, no notice (and the slow-mode notice when slow)", async () => {
    const { unmount } = await setup();
    expect(topInput()).toBeTruthy();
    expect(noticeText("pf-comment-body")).toBeNull();
    expect(closedNote()).toBeNull();
    unmount();
    await setup({ settings: view({ slowModeSecs: 60 }) });
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute.");
    expect(topInput()!.getAttribute("aria-describedby")).toContain("pf-comment-body-notice");
    expect(submitOf(topInput()!).hasAttribute("aria-disabled")).toBe(false);
  });

  it("signed in · repliesOnly: note A + you can still reply", async () => {
    await setup({ settings: view({ mode: "repliesOnly" }) });
    expect(closedNote()!.textContent).toBe("New comments are turned off for this game. You can still reply to existing threads.");
    expect(topInput()).toBeNull();
  });

  it("signed in · off: note B", async () => {
    await setup({ settings: view({ mode: "off" }) });
    expect(closedNote()!.textContent).toBe(CLOSED_B);
    expect(topInput()).toBeNull();
  });

  it("manager · on / repliesOnly / off: the form, with notice M-A / M-B; managers never see slow mode", async () => {
    let r = await setup({ settings: view({ canManage: true, slowModeSecs: 300 }) });
    expect(topInput()).toBeTruthy();
    expect(noticeText("pf-comment-body")).toBeNull();
    r.unmount();
    r = await setup({ settings: view({ canManage: true, mode: "repliesOnly" }) });
    expect(closedNote()).toBeNull();
    expect(noticeText("pf-comment-body")).toBe(M_A);
    r.unmount();
    await setup({ settings: view({ canManage: true, mode: "off", slowModeSecs: 60 }) });
    expect(closedNote()).toBeNull();
    expect(noticeText("pf-comment-body")).toBe(M_B);
  });
});

describe("Comments F020 § 2.3: header", () => {
  it("badges per state, in order, as plain text", async () => {
    let r = await setup({ settings: view() });
    expect(document.querySelector(".pf-comments__badges")).toBeNull();
    r.unmount();
    r = await setup({ settings: view({ mode: "off", slowModeSecs: 300 }) });
    expect(badges()).toEqual([
      ["Comments off", "pf-badge pf-badge--comments-off"],
      ["Slow mode · 5 min", "pf-badge"],
    ]);
    r.unmount();
    r = await setup({ signedIn: false, settings: view({ mode: "repliesOnly" }) });
    expect(badges()).toEqual([["Replies only", "pf-badge"]]);
    r.unmount();
    const shorts: [number, string][] = [
      [30, "30 s"],
      [60, "1 min"],
      [900, "15 min"],
      [3600, "1 h"],
    ];
    for (const [secs, short] of shorts) {
      r = await setup({ settings: view({ slowModeSecs: secs as CommentSettings["slowModeSecs"] }) });
      expect(badges()).toEqual([[`Slow mode · ${short}`, "pf-badge"]]);
      r.unmount();
    }
  });

  it("⚙ Settings only when canManage", async () => {
    const r = await setup({ settings: view({ mode: "off" }) });
    expect(document.getElementById("comment-settings-btn")).toBeNull();
    r.unmount();
    await setup({ settings: view({ canManage: true }) });
    const btn = screen.getByRole("button", { name: "Comment settings" });
    expect(btn.id).toBe("comment-settings-btn");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.className).toBe("pf-btn pf-btn--sm pf-btn--ghost");
    expect(btn.textContent).toBe("⚙ Settings");
    expect(btn.querySelector("[aria-hidden=true]")!.textContent).toBe("⚙");
  });

  it("older servers (no settings): nothing F020 is rendered", async () => {
    await setup({ settings: undefined, threads: [th("c1", { canModerate: true })] });
    expect(document.querySelector(".pf-comments__badges")).toBeNull();
    expect(document.getElementById("comment-settings-btn")).toBeNull();
    expect(closedNote()).toBeNull();
    expect(topInput()).toBeTruthy();
    expect(noticeText("pf-comment-body")).toBeNull();
    expect(document.getElementById("reply-btn-c1")).toBeTruthy();
  });
});

describe("Comments F020: settings dialog", () => {
  it("opens, saves in place (no reload), returns focus and announces", async () => {
    const { client } = await setup({
      settings: view({ canManage: true }),
      mocks: (c) => vi.spyOn(c, "updateCommentSettings").mockResolvedValue({ mode: "off", slowModeSecs: 60 }),
    });
    const listCalls = vi.mocked(client.listComments).mock.calls.length;
    const btn = screen.getByRole("button", { name: "Comment settings" });
    btn.focus();
    fireEvent.click(btn);
    const dialog = screen.getByRole("dialog", { name: "Comment settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Focus moves into the dialog (the checked radio).
    expect(document.activeElement).toBe(within(dialog).getByRole("radio", { name: "Everyone can comment" }));

    fireEvent.click(within(dialog).getByRole("radio", { name: "Off: no new comments or replies" }));
    fireEvent.change(within(dialog).getByLabelText("Slow mode"), { target: { value: "60" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    await flush(2);

    expect(client.updateCommentSettings).toHaveBeenCalledWith("g1", { mode: "off", slowModeSecs: 60 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("comment-settings-btn"));
    expect(liveText()).toBe("Comment settings saved");
    expect(vi.mocked(client.listComments).mock.calls.length).toBe(listCalls);
    expect(badges().map((b) => b[0])).toEqual(["Comments off", "Slow mode · 1 min"]);
    // Managers keep the form with notice M-B, and no slow-mode notice.
    expect(noticeText("pf-comment-body")).toBe(M_B);
  });

  it("Escape and Cancel close without saving; focus returns to the button", async () => {
    const { client } = await setup({ settings: view({ canManage: true }), mocks: (c) => vi.spyOn(c, "updateCommentSettings") });
    const btn = screen.getByRole("button", { name: "Comment settings" });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(client.updateCommentSettings).not.toHaveBeenCalled();
  });

  it("review 8 L3: Save keeps focus while saving and after an error; the error is announced; Cancel is ignored while saving", async () => {
    let reject!: (e: unknown) => void;
    await setup({
      settings: view({ canManage: true }),
      mocks: (c) =>
        vi.spyOn(c, "updateCommentSettings").mockReturnValue(
          new Promise<CommentSettings>((_r, j) => {
            reject = j;
          }),
        ),
    });
    const btn = screen.getByRole("button", { name: "Comment settings" });
    btn.focus();
    fireEvent.click(btn);
    const dialog = screen.getByRole("dialog", { name: "Comment settings" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Off: no new comments or replies" }));
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    save.focus();
    fireEvent.click(save);
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    // Cancel is aria-disabled and ignored while saving.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(screen.getByRole("dialog")).toBe(dialog);

    await act(async () => reject(new ApiError("validation", "mode is invalid", 422)));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("alert").textContent).toBe("mode is invalid");
    expect(document.activeElement).toBe(save);
    expect(save.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("Comments F020: Reply buttons and reply forms", () => {
  it("non-managers: hidden in off, visible in repliesOnly", async () => {
    const r = await setup({ settings: view({ mode: "off" }) });
    expect(document.getElementById("comment-c1")).toBeTruthy();
    expect(document.getElementById("reply-btn-c1")).toBeNull();
    // No per-thread note: the game-level note explains it.
    expect(document.getElementById("thread-note-c1")).toBeNull();
    r.unmount();
    await setup({ settings: view({ mode: "repliesOnly" }) });
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    expect(document.getElementById("reply-body-c1")).toBeTruthy();
    expect(noticeText("reply-body-c1")).toBeNull();
  });

  it("managers in off: Reply visible, reply form shows M-B; a locked thread shows only the F017 hint", async () => {
    await setup({
      settings: view({ canManage: true, mode: "off" }),
      threads: [th("c1", { canModerate: true }), th("c2", { canModerate: true, locked: true })],
    });
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    expect(noticeText("reply-body-c1")).toBe(M_B);
    fireEvent.click(document.getElementById("reply-btn-c2")!);
    expect(noticeText("reply-body-c2")).toBe("This thread is locked. Only you and moderators can reply.");
  });

  it("slow mode notice on reply forms (repliesOnly, non-manager)", async () => {
    await setup({ settings: view({ mode: "repliesOnly", slowModeSecs: 30 }) });
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    expect(noticeText("reply-body-c1")).toBe("Slow mode: you can post once every 30 seconds.");
  });
});

describe("Comments F020 § 2.5: slow-mode countdown (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });

  it("waitSecs from page 1: ticking notice, aria-disabled submit, submit ignored, draft kept, one end announcement", async () => {
    const { client } = await setup({
      settings: view({ slowModeSecs: 300, waitSecs: 298 }),
      mocks: (c) => vi.spyOn(c, "postComment"),
    });
    const input = topInput()!;
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 5 minutes. You can post again in 4:58.");
    // The ticking text is not in a live region.
    expect(document.getElementById("pf-comment-body-notice")!.closest("[aria-live]")).toBeNull();

    fireEvent.change(input, { target: { value: "gg" } });
    const submit = submitOf(input);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.disabled).toBe(false);
    submit.focus();
    fireEvent.click(submit);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await flush(2);
    expect(client.postComment).not.toHaveBeenCalled();
    expect(input.value).toBe("gg");
    expect(document.activeElement).toBe(submit);

    await act(async () => vi.advanceTimersByTime(1000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 5 minutes. You can post again in 4:57.");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 5 minutes. You can post again in 3:57.");
    await act(async () => vi.advanceTimersByTime(232_000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 5 minutes. You can post again in 0:05.");
    expect(liveText()).not.toBe("You can post again.");

    await act(async () => vi.advanceTimersByTime(5000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 5 minutes.");
    expect(submit.hasAttribute("aria-disabled")).toBe(false);
    expect(liveText()).toBe("You can post again.");
    const announced = liveSpan();
    await act(async () => vi.advanceTimersByTime(10_000));
    // Announced once: the live-region entry is not replaced again.
    expect(liveSpan()).toBe(announced);
    expect(input.value).toBe("gg");
  });

  it("a successful post starts a full interval", async () => {
    await setup({
      settings: view({ slowModeSecs: 60 }),
      mocks: (c) => vi.spyOn(c, "postComment").mockResolvedValue(cm("new", { author: me })),
    });
    const input = topInput()!;
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(liveText()).toBe("Comment posted");
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute. You can post again in 1:00.");
    fireEvent.change(input, { target: { value: "again" } });
    expect(submitOf(input).getAttribute("aria-disabled")).toBe("true");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute.");
    expect(liveText()).toBe("You can post again.");
  });

  it("a successful reply starts the shared countdown for every form", async () => {
    await setup({
      settings: view({ mode: "repliesOnly", slowModeSecs: 30 }),
      mocks: (c) => vi.spyOn(c, "postComment").mockResolvedValue(cm("r1", { author: me, parentId: "c1" })),
    });
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    const input = document.getElementById("reply-body-c1") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "+1" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(document.getElementById("reply-body-c1")).toBeNull();
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    expect(noticeText("reply-body-c1")).toBe("Slow mode: you can post once every 30 seconds. You can post again in 0:30.");
    expect(submitOf(document.getElementById("reply-body-c1")!).getAttribute("aria-disabled")).toBe("true");
  });

  it("a slow_mode 429 starts the countdown from Retry-After: no toast, no form error, announced", async () => {
    const { client } = await setup({
      settings: view({ slowModeSecs: 60 }),
      mocks: (c) =>
        vi
          .spyOn(c, "postComment")
          .mockRejectedValue(
            ApiError.fromResponse(429, { error: { code: "slow_mode", message: "Slow mode is on: you can post again in 42 seconds" } }, "", "42"),
          ),
    });
    const input = topInput()!;
    fireEvent.change(input, { target: { value: "draft" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(client.postComment).toHaveBeenCalledTimes(1);
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute. You can post again in 0:42.");
    expect(liveText()).toBe("Slow mode is on. You can post again in 0:42.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Slow mode is on: you can post again/)).toBeNull();
    expect(screen.queryByText(/commenting too fast/)).toBeNull();
    expect(input.value).toBe("draft");
    expect(submitOf(input).getAttribute("aria-disabled")).toBe("true");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute. You can post again in 0:40.");
  });

  it("a slow_mode 429 without Retry-After falls back to slowModeSecs", async () => {
    await setup({
      settings: view({ slowModeSecs: 30 }),
      mocks: (c) => vi.spyOn(c, "postComment").mockRejectedValue(ApiError.fromResponse(429, { error: { code: "slow_mode", message: "x" } }, "", null)),
    });
    const input = topInput()!;
    fireEvent.change(input, { target: { value: "draft" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every 30 seconds. You can post again in 0:30.");
  });

  it("the timer is cleared on unmount", async () => {
    const { unmount } = await setup({ settings: view({ slowModeSecs: 60, waitSecs: 30 }) });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const before = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(before);
  });
});

describe("Comments F020 § 2.6: server rejections while the page is open", () => {
  it("a generic 429 keeps the F006 text", async () => {
    await setup({
      settings: view({ slowModeSecs: 60 }),
      mocks: (c) => vi.spyOn(c, "postComment").mockRejectedValue(ApiError.fromResponse(429, { error: { code: "rate_limited", message: "x" } }, "", "9")),
    });
    const input = topInput()!;
    fireEvent.change(input, { target: { value: "hi" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(screen.getByRole("alert").textContent).toBe("You're commenting too fast, try again in 9s.");
    expect(noticeText("pf-comment-body")).toBe("Slow mode: you can post once every minute.");
  });

  it("422 'New comments are turned off' → repliesOnly: note A focused, badge shown, no error", async () => {
    await setup({
      mocks: (c) => vi.spyOn(c, "postComment").mockRejectedValue(new ApiError("validation", "New comments are turned off for this game", 422)),
    });
    const input = topInput()!;
    fireEvent.change(input, { target: { value: "my draft" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(topInput()).toBeNull();
    expect(closedNote()!.textContent).toBe(`${CLOSED_A} You can still reply to existing threads.`);
    expect(document.activeElement).toBe(closedNote());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(badges().map((b) => b[0])).toEqual(["Replies only"]);
    // Replies still work.
    expect(document.getElementById("reply-btn-c1")).toBeTruthy();
  });

  it("422 'Comments are turned off' on a reply → off: the reply form closes, Reply buttons go, note B focused", async () => {
    await setup({
      threads: [th("c1"), th("c2")],
      mocks: (c) => vi.spyOn(c, "postComment").mockRejectedValue(new ApiError("validation", "Comments are turned off for this game", 422)),
    });
    fireEvent.click(document.getElementById("reply-btn-c1")!);
    const input = document.getElementById("reply-body-c1") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "reply draft" } });
    await act(async () => fireEvent.click(submitOf(input)));
    await flush(2);
    expect(document.getElementById("reply-body-c1")).toBeNull();
    expect(document.getElementById("reply-btn-c1")).toBeNull();
    expect(document.getElementById("reply-btn-c2")).toBeNull();
    expect(topInput()).toBeNull();
    expect(closedNote()!.textContent).toBe(CLOSED_B);
    expect(document.activeElement).toBe(closedNote());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(badges().map((b) => b[0])).toEqual(["Comments off"]);
  });
});
