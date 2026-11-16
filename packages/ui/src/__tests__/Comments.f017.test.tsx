import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Comment, CommentListPage, CommentThread, ThreadState, User, UserRef } from "../api/types";
import { Comments } from "../components/Comments";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const alice: UserRef = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };
const mia: UserRef = { id: "u3", username: "mia", displayName: "Mia", avatarUrl: null };
const noah: UserRef = { id: "u4", username: "noah", displayName: "Noah", avatarUrl: null };

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
function reply(id: string, threadId: string, over: Partial<Comment> = {}): Comment {
  return cm(id, { parentId: threadId, author: mia, ...over });
}
function th(id: string, over: Partial<Comment> = {}, replies: Comment[] = [], replyCount = replies.length): CommentThread {
  return { ...cm(id, over), replies, replyCount };
}
/** Owner-visible thread (canModerate). */
function mod(id: string, over: Partial<Comment> = {}, replies: Comment[] = []): CommentThread {
  return th(id, { canModerate: true, ...over }, replies);
}
function listPage(items: CommentThread[], total: number, totalAll: number, pinned: CommentThread | null = null, page = 1): CommentListPage {
  return { items, total, totalAll, page, perPage: 20, pinned };
}
function state(id: string, over: Partial<ThreadState> = {}): ThreadState {
  return { id, pinned: false, locked: false, unpinnedId: null, ...over };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Mocks = (c: ApiClient) => void;

async function setup(mocks: Mocks, { focusCommentId = null as string | null } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  mocks(client);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <Comments gameId="g1" focusCommentId={focusCommentId} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { client, ...utils };
}

const article = (id: string) => document.getElementById(`comment-${id}`) as HTMLElement;
const liveText = () => document.querySelector(".pf-panel > [role=status]")!.textContent;
const mainIds = () =>
  Array.from(screen.getByRole("list", { name: "Comments" }).children)
    .map((li) => li.querySelector(":scope > article")?.id.replace("comment-", ""))
    .filter(Boolean);
const pinnedList = () => screen.queryByRole("list", { name: "Pinned comment" });

describe("Comments sort (F017 § 2.1)", () => {
  it("toggles Newest/Top: aria-pressed, sort=top, list reset with aria-busy, focus kept, announced and remembered", async () => {
    const next = deferred<CommentListPage>();
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockImplementation(async (_g, q) => (q?.sort === "top" ? next.promise : listPage([th("c1"), th("c2")], 2, 2)));
    });
    const group = await screen.findByRole("group", { name: "Sort comments" });
    expect(client.listComments).toHaveBeenCalledWith("g1", { page: 1, perPage: 20, sort: "new" });
    const newest = within(group).getByRole("button", { name: "Newest" });
    const top = within(group).getByRole("button", { name: "Top" });
    expect(newest.getAttribute("aria-pressed")).toBe("true");
    expect(top.getAttribute("aria-pressed")).toBe("false");
    expect(top.getAttribute("type")).toBe("button");

    top.focus();
    fireEvent.click(top);
    expect(top.getAttribute("aria-pressed")).toBe("true");
    expect(newest.getAttribute("aria-pressed")).toBe("false");
    expect(client.listComments).toHaveBeenLastCalledWith("g1", { page: 1, perPage: 20, sort: "top" });
    // The old threads are cleared and the list is busy while page 1 loads.
    expect(article("c1")).toBeNull();
    expect(screen.getByRole("list", { name: "Comments" }).getAttribute("aria-busy")).toBe("true");
    expect(liveText()).toBe("Comments sorted by top");
    expect(localStorage.getItem("webgame.comments.sort")).toBe("top");
    expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();

    await act(async () => next.resolve(listPage([th("c2", { hearts: 3 }), th("c1")], 2, 2)));
    expect(mainIds()).toEqual(["c2", "c1"]);
    expect(screen.getByRole("list", { name: "Comments" }).hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(top);

    fireEvent.click(newest);
    await waitFor(() => expect(mainIds()).toEqual(["c1", "c2"]));
    expect(liveText()).toBe("Comments sorted by newest");
    expect(localStorage.getItem("webgame.comments.sort")).toBe("new");
    // Clicking the pressed one again does nothing.
    const calls = vi.mocked(client.listComments).mock.calls.length;
    fireEvent.click(newest);
    expect(vi.mocked(client.listComments).mock.calls.length).toBe(calls);
  });

  it("restores the stored sort; an invalid stored value reads as newest", async () => {
    localStorage.setItem("webgame.comments.sort", "top");
    const { client, unmount } = await setup((c) => vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1")], 1, 1)));
    expect(client.listComments).toHaveBeenCalledWith("g1", { page: 1, perPage: 20, sort: "top" });
    expect((await screen.findByRole("button", { name: "Top" })).getAttribute("aria-pressed")).toBe("true");
    unmount();

    localStorage.setItem("webgame.comments.sort", "hot");
    const second = await setup((c) => vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1")], 1, 1)));
    expect(second.client.listComments).toHaveBeenCalledWith("g1", { page: 1, perPage: 20, sort: "new" });
    expect((await screen.findByRole("button", { name: "Newest" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("older servers (no `pinned` key): no sort toggle and no pin/lock tools", async () => {
    await setup((c) =>
      vi.spyOn(c, "listComments").mockResolvedValue({ items: [mod("c1")], total: 1, totalAll: 1, page: 1, perPage: 20 } as never),
    );
    await waitFor(() => expect(article("c1")).toBeTruthy());
    expect(screen.queryByRole("group", { name: "Sort comments" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pin comment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Lock replies/ })).toBeNull();
    expect(pinnedList()).toBeNull();
  });
});

describe("Pinned thread (F017 § 2.2)", () => {
  it("renders first in its own labelled list with the badge, and is excluded from load-more math", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => th(`p${i}`));
    const pinned = th("pin", { pinned: true, author: noah }, [reply("pr1", "pin")], 1);
    await setup((c) =>
      vi.spyOn(c, "listComments").mockImplementation(async (_g, q) =>
        q?.page === 2 ? listPage([th("p20")], 21, 23, { ...pinned, body: "ignored" }, 2) : listPage(page1, 21, 23, pinned),
      ),
    );
    const plist = await screen.findByRole("list", { name: "Pinned comment" });
    expect(plist.className).toContain("pf-comments--pinned");
    const main = screen.getByRole("list", { name: "Comments" });
    // Before the main list in document order.
    expect(plist.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plist.contains(article("pin"))).toBe(true);
    expect(within(plist).getByRole("list", { name: "Replies to Noah" })).toBeTruthy();
    const badge = within(article("pin")).getByText("Pinned", { exact: false, selector: ".pf-badge" });
    expect(badge.className).toContain("pf-badge--pinned");
    expect(main.contains(article("pin"))).toBe(false);

    // 20 loaded of total 21 (pinned not counted): Load more.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    });
    await waitFor(() => expect(article("p20")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();
    expect(document.querySelectorAll("#comment-pin")).toHaveLength(1);
    // Later pages' `pinned` is ignored.
    expect(within(article("pin")).getByText("Body pin")).toBeTruthy();
  });

  it("a permalink into the pinned thread highlights and focuses it in place, with no linked copy", async () => {
    const pinned = th("pin", { pinned: true }, [reply("pr1", "pin")], 1);
    await setup(
      (c) => {
        vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1")], 1, 3, pinned));
        vi.spyOn(c, "getComment").mockResolvedValue({ comment: pinned.replies[0], thread: pinned });
      },
      { focusCommentId: "pr1" },
    );
    await waitFor(() => expect(document.activeElement).toBe(article("pr1")));
    expect(pinnedList()!.contains(article("pr1"))).toBe(true);
    expect(article("pr1").className).toContain("pf-comment--highlight");
    expect(screen.queryByText("Linked comment")).toBeNull();
    expect(document.querySelectorAll("#comment-pin")).toHaveLength(1);
    expect(mainIds()).toEqual(["c1"]);
  });
});

describe("Pin and unpin (F017 § 2.3, § 2.4)", () => {
  it("confirms a replacement, moves the thread, returns the old pin to its sorted place, focuses Unpin", async () => {
    const oldPin = mod("old", { pinned: true, author: noah, createdAt: "2026-11-15T09:00:00Z" });
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(
        listPage(
          [mod("c1", { createdAt: "2026-11-15T10:00:00Z" }), mod("c2", { createdAt: "2026-11-15T08:30:00Z" }), mod("c3", { createdAt: "2026-11-15T08:00:00Z" })],
          3,
          4,
          oldPin,
        ),
      );
      vi.spyOn(c, "pinComment").mockResolvedValue(state("c3", { pinned: true, unpinnedId: "old" }));
    });
    const pin3 = await waitFor(() => document.getElementById("pin-btn-c3") as HTMLButtonElement);
    expect(pin3.getAttribute("aria-label")).toBe("Pin comment by Alice");

    // Cancel: nothing changes, focus returns to Pin.
    pin3.focus();
    fireEvent.click(pin3);
    const dialog = screen.getByRole("dialog", { name: "Replace the pinned comment?" });
    expect(within(dialog).getByText("Only one comment can be pinned. The comment by Noah will be unpinned.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.pinComment).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("pin-btn-c3")));

    // Confirm.
    pin3.focus();
    fireEvent.click(pin3);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pin this one" }));
    });
    expect(client.pinComment).toHaveBeenCalledWith("c3");
    await waitFor(() => expect(pinnedList()!.contains(article("c3"))).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The old pin goes back between c1 (10:00) and c2 (08:30).
    expect(mainIds()).toEqual(["c1", "old", "c2"]);
    expect(within(article("old")).queryByText("Pinned", { exact: false, selector: ".pf-badge" })).toBeNull();
    expect(within(article("c3")).getByText("Pinned", { exact: false, selector: ".pf-badge" })).toBeTruthy();
    const unpin = document.getElementById("pin-btn-c3")!;
    expect(unpin.textContent).toBe("Unpin");
    expect(unpin.getAttribute("aria-label")).toBe("Unpin comment by Alice");
    await waitFor(() => expect(document.activeElement).toBe(unpin));
    expect(liveText()).toBe("Comment pinned");
  });

  it("pins without confirmation when nothing is pinned; unpin returns it and focuses Pin", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(
        listPage([mod("c1", { createdAt: "2026-11-15T10:00:00Z" }), mod("c2", { createdAt: "2026-11-15T09:00:00Z" })], 2, 2),
      );
      vi.spyOn(c, "pinComment").mockResolvedValue(state("c2", { pinned: true }));
      vi.spyOn(c, "unpinComment").mockResolvedValue(state("c2"));
    });
    await waitFor(() => expect(article("c2")).toBeTruthy());
    expect(pinnedList()).toBeNull();
    await act(async () => {
      fireEvent.click(document.getElementById("pin-btn-c2")!);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(pinnedList()!.contains(article("c2"))).toBe(true));
    expect(mainIds()).toEqual(["c1"]);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("pin-btn-c2")));

    await act(async () => {
      fireEvent.click(document.getElementById("pin-btn-c2")!);
    });
    expect(client.unpinComment).toHaveBeenCalledWith("c2");
    await waitFor(() => expect(pinnedList()).toBeNull());
    expect(mainIds()).toEqual(["c1", "c2"]);
    const pin = document.getElementById("pin-btn-c2")!;
    expect(pin.textContent).toBe("Pin");
    await waitFor(() => expect(document.activeElement).toBe(pin));
    expect(liveText()).toBe("Comment unpinned");
  });

  it("a returned thread that sorts after the loaded ones is left for a later page (Top sort, total adjusted)", async () => {
    localStorage.setItem("webgame.comments.sort", "top");
    const page1 = Array.from({ length: 20 }, (_, i) => mod(`p${i}`, { hearts: 5 }));
    const oldPin = mod("old", { pinned: true, hearts: 1 });
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockImplementation(async (_g, q) =>
        q?.page === 2 ? listPage([mod("p20", { hearts: 2 }), mod("old", { hearts: 1 })], 21, 22, mod("p0", { pinned: true }), 2) : listPage(page1, 21, 22, oldPin),
      );
      vi.spyOn(c, "pinComment").mockResolvedValue(state("p0", { pinned: true, unpinnedId: "old" }));
    });
    await waitFor(() => expect(article("p0")).toBeTruthy());
    fireEvent.click(document.getElementById("pin-btn-p0")!);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pin this one" }));
    });
    await waitFor(() => expect(pinnedList()!.contains(article("p0"))).toBe(true));
    expect(client.pinComment).toHaveBeenCalledWith("p0");
    // 19 loaded, total 21 - 1 + 1 = 21: the old pin isn't shown yet, more pages remain.
    expect(article("old")).toBeNull();
    expect(mainIds()).toHaveLength(19);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    });
    await waitFor(() => expect(article("old")).toBeTruthy());
    expect(mainIds().slice(-2)).toEqual(["p20", "old"]);
    // The pinned slot keeps the local pin (later pages' `pinned` is ignored) and nothing is duplicated.
    expect(document.querySelectorAll("#comment-p0")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();
  });

  it("errors are toasts and change nothing; 404 removes the thread; 429 shows Retry-After", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([mod("c1"), mod("c2")], 2, 2));
      vi.spyOn(c, "pinComment").mockRejectedValueOnce(new ApiError("rate_limited", "Too many", 429, 42));
      vi.spyOn(c, "lockComment").mockRejectedValueOnce(new ApiError("not_found", "Comment not found", 404));
    });
    await waitFor(() => expect(article("c1")).toBeTruthy());
    await act(async () => {
      fireEvent.click(document.getElementById("pin-btn-c1")!);
    });
    expect(client.pinComment).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("Slow down, try again in 42s")).toBeTruthy();
    expect(pinnedList()).toBeNull();
    expect(mainIds()).toEqual(["c1", "c2"]);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("pin-btn-c1")));

    await act(async () => {
      fireEvent.click(document.getElementById("lock-btn-c2")!);
    });
    expect(await screen.findByText("This comment was deleted")).toBeTruthy();
    await waitFor(() => expect(article("c2")).toBeNull());
  });

  it("ignores clicks while a request is in flight", async () => {
    const pending = deferred<ThreadState>();
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([mod("c1")], 1, 1));
      vi.spyOn(c, "lockComment").mockReturnValue(pending.promise);
    });
    await waitFor(() => expect(article("c1")).toBeTruthy());
    const lock = document.getElementById("lock-btn-c1") as HTMLButtonElement;
    fireEvent.click(lock);
    fireEvent.click(lock);
    expect(client.lockComment).toHaveBeenCalledTimes(1);
    expect(lock.disabled).toBe(false);
    expect(lock.getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.resolve(state("c1", { locked: true })));
    expect(lock.textContent).toBe("Unlock");
  });
});

describe("Locked threads (F017 § 2.5)", () => {
  it("Lock / Unlock update in place, keep focus and announce", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([mod("c1", {}, [reply("r1", "c1")])], 1, 2));
      vi.spyOn(c, "lockComment").mockResolvedValue(state("c1", { locked: true }));
      vi.spyOn(c, "unlockComment").mockResolvedValue(state("c1", { locked: false }));
    });
    await waitFor(() => expect(article("c1")).toBeTruthy());
    const lock = document.getElementById("lock-btn-c1")!;
    expect(lock.getAttribute("aria-label")).toBe("Lock replies to comment by Alice");
    lock.focus();
    await act(async () => {
      fireEvent.click(lock);
    });
    expect(client.lockComment).toHaveBeenCalledWith("c1");
    expect(lock.textContent).toBe("Unlock");
    expect(lock.getAttribute("aria-label")).toBe("Unlock replies to comment by Alice");
    expect(within(article("c1")).getByText("Locked", { exact: false, selector: ".pf-badge" }).className).toContain("pf-badge--locked");
    expect(document.getElementById("thread-note-c1")!.textContent).toBe("Replies are turned off for this thread.");
    // The moderator keeps Reply.
    expect(within(article("c1")).getByRole("button", { name: "Reply to Alice" })).toBeTruthy();
    expect(document.activeElement).toBe(lock);
    expect(liveText()).toBe("Thread locked");

    await act(async () => {
      fireEvent.click(lock);
    });
    expect(client.unlockComment).toHaveBeenCalledWith("c1");
    expect(lock.textContent).toBe("Lock");
    expect(document.getElementById("thread-note-c1")).toBeNull();
    expect(document.activeElement).toBe(lock);
    expect(liveText()).toBe("Thread unlocked");
  });

  it("hides Reply for non-moderators and shows the note after the replies", async () => {
    await setup((c) =>
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", { locked: true }, [reply("r1", "c1")], 4), th("c2")], 2, 6)),
    );
    await waitFor(() => expect(article("c1")).toBeTruthy());
    expect(within(article("c1")).queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(within(article("r1")).queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(within(article("c2")).getByRole("button", { name: "Reply to Alice" })).toBeTruthy();
    // Hearts and Report still work.
    expect(within(article("c1")).getByRole("button", { name: /Report/ })).toBeTruthy();
    const note = document.getElementById("thread-note-c1")!;
    expect(note.className).toContain("pf-thread-note");
    const li = article("c1").closest("li")!;
    const more = within(li).getByRole("button", { name: "Show 3 more replies" });
    expect(more.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(li).getByRole("list", { name: "Replies to Alice" }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No tools for non-moderators.
    expect(document.getElementById("pin-btn-c1")).toBeNull();
  });

  it("a moderator's reply form in a locked thread shows the hint", async () => {
    await setup((c) => vi.spyOn(c, "listComments").mockResolvedValue(listPage([mod("c1", { locked: true })], 1, 1)));
    await waitFor(() => expect(article("c1")).toBeTruthy());
    fireEvent.click(within(article("c1")).getByRole("button", { name: "Reply to Alice" }));
    const form = document.getElementById("reply-form-c1")!;
    const hint = within(form).getByText(/This thread is locked\. Only you and moderators can reply\./);
    const ta = screen.getByLabelText("Write a reply to Alice");
    expect(ta.getAttribute("aria-describedby")).toContain(hint.closest("p")!.id);
    expect(hint.closest("p")!.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a 422 'locked' reply shows the error inline, marks the thread locked and focuses the note", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", {}, [reply("r1", "c1")])], 1, 2));
      vi.spyOn(c, "postComment").mockRejectedValue(new ApiError("validation", "This thread is locked", 422));
    });
    await waitFor(() => expect(article("c1")).toBeTruthy());
    fireEvent.click(within(article("c1")).getByRole("button", { name: "Reply to Alice" }));
    const ta = screen.getByLabelText("Write a reply to Alice");
    fireEvent.change(ta, { target: { value: "one more thing" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    expect(client.postComment).toHaveBeenCalledWith("g1", "one more thing", "c1");
    expect(within(document.getElementById("reply-form-c1")!).getByRole("alert").textContent).toBe("This thread is locked");
    expect(within(article("c1")).queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(within(article("r1")).queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(within(article("c1")).getByText("Locked", { exact: false, selector: ".pf-badge" })).toBeTruthy();
    const note = document.getElementById("thread-note-c1")!;
    await waitFor(() => expect(document.activeElement).toBe(note));
    // Cancel closes the form (the draft is kept in memory) and focus stays on the note.
    fireEvent.click(within(document.getElementById("reply-form-c1")!).getByRole("button", { name: "Cancel" }));
    expect(document.getElementById("reply-form-c1")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(note));
  });
});
