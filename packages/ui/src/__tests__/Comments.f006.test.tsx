import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Comment, CommentListPage, CommentThread, Page, Report, User, UserRef } from "../api/types";
import { Comments } from "../components/Comments";
import { AdminPage } from "../pages/AdminPage";
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
    ...over,
  };
}
function reply(id: string, threadId: string, over: Partial<Comment> = {}): Comment {
  return cm(id, { parentId: threadId, author: mia, ...over });
}
function th(id: string, replies: Comment[] = [], replyCount = replies.length, over: Partial<Comment> = {}): CommentThread {
  return { ...cm(id, over), replies, replyCount };
}
function listPage(items: CommentThread[], total: number, totalAll: number, page = 1): CommentListPage {
  return { items, total, totalAll, page, perPage: 20 };
}
function repliesPage(items: Comment[], total: number, page = 1, perPage = 50): Page<Comment> {
  return { items, total, page, perPage };
}

type Mocks = (c: ApiClient) => void;

async function setup(mocks: Mocks, { loggedIn = true, user = me, focusCommentId = null as string | null, isGameOwner = false, children = null as React.ReactNode } = {}) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(user);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  mocks(client);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{children ?? <Comments gameId="g1" isGameOwner={isGameOwner} focusCommentId={focusCommentId} />}</MemoryRouter>
    </WebGameProviders>,
  );
  if (loggedIn) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { client, ...utils };
}

const article = (id: string) => document.getElementById(`comment-${id}`) as HTMLElement;
const liveText = () => document.querySelector(".pf-panel > [role=status]")!.textContent;

describe("Comments threads (F006)", () => {
  it("renders threads as nested, labelled lists of articles", async () => {
    await setup((c) =>
      vi.spyOn(c, "listComments").mockResolvedValue(
        listPage(
          [
            th("c1", [reply("r1", "c1", { author: noah, isCreator: true }), reply("r2", "c1", { replyTo: noah })], 2),
            th("c2", [], 0, { author: mia }),
          ],
          2,
          4,
        ),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Comments 4" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Comments" });
    expect(list.className).toContain("pf-comments");
    const threads = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(threads).toHaveLength(2);
    const a1 = article("c1");
    expect(a1.tagName).toBe("ARTICLE");
    expect(a1.getAttribute("aria-labelledby")).toBe("comment-c1-author");
    expect(document.getElementById("comment-c1-author")!.textContent).toBe("Alice");
    expect(a1.parentElement).toBe(threads[0]);
    const replies = within(threads[0]).getByRole("list", { name: "Replies to Alice" });
    expect(replies.className).toContain("pf-replies");
    expect(replies.previousElementSibling).toBe(a1);
    expect(within(replies).getAllByRole("listitem")).toHaveLength(2);
    expect(article("r1").closest("li")!.parentElement).toBe(replies);
    // Creator badge (visible text, not colour only) and "Replying to" as a profile link.
    expect(within(article("r1")).getByText("Creator").className).toContain("pf-badge--creator");
    const replyTo = within(article("r2")).getByRole("link", { name: "@noah" });
    expect(replyTo.getAttribute("href")).toBe("/u/noah");
    expect(within(article("r2")).getByText(/Replying to/)).toBeTruthy();
    // Time is a permalink (query, not hash).
    const time = article("r2").querySelector("time")!.closest("a")!;
    expect(time.getAttribute("href")).toBe("/games/g1?comment=r2");
    // No role=tree anywhere.
    expect(document.querySelector("[role=tree]")).toBeNull();
    // Reply buttons control their thread's form.
    const rb = within(article("r2")).getByRole("button", { name: "Reply to Mia" });
    expect(rb.getAttribute("aria-controls")).toBe("reply-form-c1");
    expect(rb.getAttribute("aria-expanded")).toBe("false");
  });

  it("'Show N more replies' loads 50 per page, dedupes and focuses the first new reply", async () => {
    const preview = [reply("r1", "c1"), reply("r2", "c1"), reply("r3", "c1")];
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", preview, 5)], 1, 6));
      vi.spyOn(c, "listReplies").mockResolvedValue(repliesPage([...preview, reply("r4", "c1"), reply("r5", "c1")], 5));
    });
    const more = await screen.findByRole("button", { name: "Show 2 more replies" });
    fireEvent.click(more);
    await waitFor(() => expect(article("r5")).toBeTruthy());
    expect(client.listReplies).toHaveBeenCalledWith("c1", { page: 1, perPage: 50 });
    const ids = Array.from(screen.getByRole("list", { name: "Replies to Alice" }).querySelectorAll("article")).map((a) => a.id);
    expect(ids).toEqual(["comment-r1", "comment-r2", "comment-r3", "comment-r4", "comment-r5"]);
    expect(screen.queryByRole("button", { name: /more repl/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(article("r4")));
    expect(liveText()).toBe("2 more replies loaded");
  });

  it("opens one reply form, focuses it, and Escape / Cancel close it and return focus (draft kept)", async () => {
    await setup((c) => vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", [reply("r1", "c1")], 1), th("c2")], 2, 3)));
    await waitFor(() => expect(article("c1")).toBeTruthy());
    const replyBtn = within(article("c1")).getByRole("button", { name: "Reply to Alice" });
    fireEvent.click(replyBtn);
    const ta = (await screen.findByLabelText("Write a reply to Alice")) as HTMLTextAreaElement;
    expect(document.getElementById("reply-form-c1")).toBeTruthy();
    expect(replyBtn.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(ta));
    fireEvent.change(ta, { target: { value: "draft one" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(document.getElementById("reply-form-c1")).toBeNull();
    expect(replyBtn.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(replyBtn));

    // Opening another thread's form closes nothing permanently: the first draft survives.
    const replyBtn2 = within(article("c2")).getByRole("button", { name: "Reply to Alice" });
    fireEvent.click(replyBtn2);
    expect(document.getElementById("reply-form-c2")).toBeTruthy();
    fireEvent.click(replyBtn);
    expect(document.getElementById("reply-form-c2")).toBeNull();
    const ta1 = document.getElementById("reply-body-c1") as HTMLTextAreaElement;
    expect(ta1.value).toBe("draft one");
    fireEvent.click(within(document.getElementById("reply-form-c1")!).getByRole("button", { name: "Cancel" }));
    expect(document.getElementById("reply-form-c1")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(replyBtn));
  });

  it("Ctrl+Enter submits; a reply opened from a reply sends that reply's id, the ✕ sends the thread's id", async () => {
    const posted = reply("r9", "c1", { author: me, replyTo: mia, canDelete: true });
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", [reply("r1", "c1")], 1)], 1, 2));
      vi.spyOn(c, "postComment").mockResolvedValue(posted);
    });
    await screen.findByRole("heading", { name: "Comments 2" });
    fireEvent.click(within(article("r1")).getByRole("button", { name: "Reply to Mia" }));
    expect(screen.getByText("@mia").closest("p")!.textContent).toContain("Replying to @mia");
    const ta = screen.getByLabelText("Write a reply to @mia");
    fireEvent.change(ta, { target: { value: "Press Esc twice" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    expect(client.postComment).toHaveBeenLastCalledWith("g1", "Press Esc twice", "r1");
    await waitFor(() => expect(article("r9")).toBeTruthy());
    expect(liveText()).toBe("Reply posted");
    await waitFor(() => expect(document.activeElement).toBe(article("r9")));
    expect(screen.getByRole("heading", { name: "Comments 3" })).toBeTruthy();

    // Again from r1, but clear the chip: parentId is the thread.
    fireEvent.click(within(article("r1")).getByRole("button", { name: "Reply to Mia" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop replying to @mia" }));
    expect(screen.queryByText("@mia", { selector: "strong" })).toBeNull();
    const ta2 = screen.getByLabelText("Write a reply to Alice");
    fireEvent.change(ta2, { target: { value: "general reply" } });
    vi.mocked(client.postComment).mockResolvedValue(reply("r10", "c1", { author: me }));
    await act(async () => {
      fireEvent.keyDown(ta2, { key: "Enter", metaKey: true });
    });
    expect(client.postComment).toHaveBeenLastCalledWith("g1", "general reply", "c1");
  });

  it("Ctrl+Enter submits the top-level form", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([], 0, 0));
      vi.spyOn(c, "postComment").mockResolvedValue(cm("c5", { author: me, canDelete: true }));
    });
    const ta = await screen.findByLabelText("Write a comment");
    fireEvent.change(ta, { target: { value: "  hello  " } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    expect(client.postComment).toHaveBeenCalledWith("g1", "hello");
    await waitFor(() => expect(article("c5")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Comments 1" })).toBeTruthy();
    expect(liveText()).toBe("Comment posted");
  });

  it("appends a new reply after loading the hidden ones, so it's never out of order", async () => {
    const preview = [reply("r1", "c1"), reply("r2", "c1"), reply("r3", "c1")];
    const posted = reply("r9", "c1", { author: me });
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", preview, 4)], 1, 5));
      vi.spyOn(c, "postComment").mockResolvedValue(posted);
      vi.spyOn(c, "listReplies").mockResolvedValue(repliesPage([...preview, reply("r4", "c1"), posted], 5, 1, 100));
    });
    fireEvent.click(await within(await waitFor(() => article("c1"))).findByRole("button", { name: "Reply to Alice" }));
    const ta = screen.getByLabelText("Write a reply to Alice");
    fireEvent.change(ta, { target: { value: "late reply" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    });
    await waitFor(() => expect(article("r9")).toBeTruthy());
    expect(client.listReplies).toHaveBeenCalledWith("c1", { page: 1, perPage: 100 });
    const ids = Array.from(screen.getByRole("list", { name: "Replies to Alice" }).querySelectorAll("article")).map((a) => a.id);
    expect(ids).toEqual(["comment-r1", "comment-r2", "comment-r3", "comment-r4", "comment-r9"]);
    expect(screen.queryByRole("button", { name: /more repl/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Comments 6" })).toBeTruthy();
    expect(document.getElementById("reply-form-c1")).toBeNull();
  });

  it("shows 422/429 errors inline and removes the thread on 404", async () => {
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1", [reply("r1", "c1")], 1), th("c2")], 2, 3));
      vi.spyOn(c, "postComment").mockRejectedValueOnce(new ApiError("validation", "This thread has reached 200 replies", 422));
    });
    fireEvent.click(await within(await waitFor(() => article("c1"))).findByRole("button", { name: "Reply to Alice" }));
    const ta = screen.getByLabelText("Write a reply to Alice");
    fireEvent.change(ta, { target: { value: "x" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    expect((await screen.findByRole("alert")).textContent).toBe("This thread has reached 200 replies");

    vi.mocked(client.postComment).mockRejectedValueOnce(new ApiError("rate_limited", "Slow down", 429, 12));
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    expect(screen.getByRole("alert").textContent).toBe("You're commenting too fast, try again in 12s.");

    vi.mocked(client.postComment).mockRejectedValueOnce(new ApiError("not_found", "Comment not found", 404));
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(article("c1")).toBeNull());
    expect(screen.getByText("This comment was deleted")).toBeTruthy();
    expect(article("c2")).toBeTruthy();
    // total 2 → 1 thread, totalAll 3 → 1
    expect(screen.getByRole("heading", { name: "Comments 1" })).toBeTruthy();
  });

  it("deletes replies and empty threads at once, and confirms only for threads with replies", async () => {
    const mine = { author: me, canDelete: true };
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(
        listPage([th("c1", [reply("r1", "c1", mine), reply("r2", "c1")], 2, mine), th("c2", [], 0, mine), th("c3")], 3, 5),
      );
      vi.spyOn(c, "deleteComment").mockResolvedValue(undefined);
    });
    await screen.findByRole("heading", { name: "Comments 5" });
    // Others' comments without canDelete have no Delete button.
    expect(within(article("c3")).queryByRole("button", { name: "Delete" })).toBeNull();

    // A reply: no dialog.
    await act(async () => {
      fireEvent.click(within(article("r1")).getByRole("button", { name: "Delete" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.deleteComment).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(article("r1")).toBeNull());
    expect(screen.getByRole("heading", { name: "Comments 4" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(article("r2")));
    expect(liveText()).toBe("Comment deleted");

    // A thread with 1 reply: confirm.
    fireEvent.click(within(article("c1")).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this comment and its 1 reply?" });
    expect(within(dialog).getByText("Replies by other people are removed too. This cannot be undone.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(article("c1")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(article("r2")).toBeNull();
    // totalAll 4 - (1 + 1)
    expect(screen.getByRole("heading", { name: "Comments 2" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(article("c2")));

    // A thread without replies: no dialog.
    await act(async () => {
      fireEvent.click(within(article("c2")).getByRole("button", { name: "Delete" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(article("c2")).toBeNull());
    expect(screen.getByRole("heading", { name: "Comments 1" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(article("c3")));
  });

  it("falls back for older servers: no replies or hearts, v1 delete rule, total as the count", async () => {
    const v1 = (id: string, author: UserRef) => ({ id, gameId: "g1", author, body: "old", createdAt: "2026-11-15T10:00:00Z" });
    await setup((c) =>
      vi.spyOn(c, "listComments").mockResolvedValue({ items: [v1("c1", me), v1("c2", alice)], total: 2, page: 1, perPage: 20 } as never),
    );
    expect(await screen.findByRole("heading", { name: "Comments 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Heart/ })).toBeNull();
    expect(within(article("c1")).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(article("c2")).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("Comment permalinks (F006)", () => {
  it("shows the linked thread first, focused and highlighted, and doesn't repeat it on later pages", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => th(`p${i}`));
    const linked = th("x1", [reply("xr1", "x1")], 1);
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockImplementation(async (_g, q) =>
        q?.page === 2 ? listPage([th("p20"), linked], 22, 30, 2) : listPage(page1, 22, 30),
      );
      vi.spyOn(c, "getComment").mockResolvedValue({ comment: linked, thread: linked });
    }, { focusCommentId: "x1" });
    await waitFor(() => expect(article("x1")).toBeTruthy());
    expect(client.getComment).toHaveBeenCalledWith("x1");
    const list = screen.getByRole("list", { name: "Comments" });
    const first = list.firstElementChild as HTMLElement;
    expect(first.textContent).toContain("Linked comment");
    expect(first.contains(article("x1"))).toBe(true);
    expect(article("x1").className).toContain("pf-comment--highlight");
    await waitFor(() => expect(document.activeElement).toBe(article("x1")));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    });
    await waitFor(() => expect(article("p20")).toBeTruthy());
    expect(document.querySelectorAll("#comment-x1")).toHaveLength(1);
    // 20 + p20 + the pinned one (seen on page 2) = 22 = total: no more button.
    expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();
  });

  it("keeps a linked thread that is on page 1 in place", async () => {
    const t = th("c2");
    await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1"), t], 2, 2));
      vi.spyOn(c, "getComment").mockResolvedValue({ comment: t, thread: t });
    }, { focusCommentId: "c2" });
    await waitFor(() => expect(document.activeElement).toBe(article("c2")));
    expect(screen.queryByText("Linked comment")).toBeNull();
    const ids = Array.from(screen.getByRole("list", { name: "Comments" }).children).map((li) => li.querySelector("article")!.id);
    expect(ids).toEqual(["comment-c1", "comment-c2"]);
    expect(article("c2").className).toContain("pf-comment--highlight");
  });

  it("loads the thread's replies to find a hidden linked reply", async () => {
    const preview = [reply("r1", "c1"), reply("r2", "c1"), reply("r3", "c1")];
    const target = reply("r5", "c1", { replyTo: noah });
    const thread = th("c1", preview, 5);
    const { client } = await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([thread], 1, 6));
      vi.spyOn(c, "getComment").mockResolvedValue({ comment: target, thread });
      vi.spyOn(c, "listReplies").mockResolvedValue(repliesPage([...preview, reply("r4", "c1"), target], 5, 1, 100));
    }, { focusCommentId: "r5" });
    await waitFor(() => expect(article("r5")).toBeTruthy());
    expect(client.listReplies).toHaveBeenCalledWith("c1", { page: 1, perPage: 100 });
    expect(article("r5").className).toContain("pf-comment--highlight");
    await waitFor(() => expect(document.activeElement).toBe(article("r5")));
    expect(screen.queryByRole("button", { name: /more repl/ })).toBeNull();
  });

  it("shows an info alert when the linked comment is gone, and the page still works", async () => {
    await setup((c) => {
      vi.spyOn(c, "listComments").mockResolvedValue(listPage([th("c1")], 1, 1));
      vi.spyOn(c, "getComment").mockRejectedValue(new ApiError("not_found", "Comment not found", 404));
    }, { focusCommentId: "gone" });
    const alert = await screen.findByText("That comment is no longer available.");
    expect(alert.getAttribute("role")).toBe("status");
    expect(alert.className).toContain("pf-alert--info");
    expect(article("c1")).toBeTruthy();
  });
});

describe("AdminPage comment reports (F006)", () => {
  it("links comment reports to the comment in context and explains the cascade", async () => {
    const admin: User = { ...me, role: "admin" };
    const report: Report = {
      id: "rep1",
      targetType: "comment",
      targetId: "r7",
      targetPreview: "rude reply",
      targetGameId: "g1",
      reason: "offensive",
      details: "",
      reporter: alice,
      status: "open",
      resolution: null,
      createdAt: "2026-11-15T10:00:00Z",
      resolvedAt: null,
      targetImageUrl: null,
      targetImageFullUrl: null,
    };
    await setup((c) => vi.spyOn(c, "listReports").mockResolvedValue({ items: [report], total: 1, page: 1, perPage: 25 }), {
      user: admin,
      children: <AdminPage />,
    });
    const link = await screen.findByRole("link", { name: /View in context/ });
    expect(link.getAttribute("href")).toBe("/games/g1?comment=r7");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("The comment is removed permanently, together with any replies to it.")).toBeTruthy();
  });
});
