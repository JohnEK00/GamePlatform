import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Page, Post, PostReply, User } from "../api/types";
import { PostThread } from "../components/PostThread";
import { formatDate } from "../util";
import { leoUser, miaUser, rootUser } from "./postFixtures";
import { deferred, kaiRef, leoRef, miaRef, reply, socialPost } from "./postReplyFixtures";
import { makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const pageOf = (items: PostReply[]): Page<PostReply> => ({ items, total: items.length, page: 1, perPage: 200 });

function Harness({ initial, onChange, replyId }: { initial: Post; onChange: (p: Post) => void; replyId?: string | null }) {
  const [p, setP] = useState(initial);
  return (
    <PostThread
      post={p}
      replyId={replyId}
      onPostChange={(n) => {
        onChange(n);
        setP(n);
      }}
    />
  );
}

type SetupOpts = {
  me?: User | null;
  post?: Post;
  replies?: PostReply[] | (() => Promise<Page<PostReply>>);
  url?: string;
  replyId?: string | null;
};

async function setup(opts: SetupOpts = {}) {
  const me = opts.me ?? null;
  const client = makeClient(me);
  const p = opts.post ?? socialPost("p1", { replyCount: Array.isArray(opts.replies) ? opts.replies.length : 0 });
  const list = vi
    .spyOn(client, "listPostReplies")
    .mockImplementation(typeof opts.replies === "function" ? opts.replies : async () => pageOf((opts.replies as PostReply[] | undefined) ?? []));
  const create = vi.spyOn(client, "createPostReply");
  const del = vi.spyOn(client, "deletePostReply").mockResolvedValue(undefined);
  const lock = vi.spyOn(client, "lockPost").mockImplementation(async () => ({ ...p, locked: true }));
  const unlock = vi.spyOn(client, "unlockPost").mockImplementation(async () => ({ ...p, locked: false }));
  const onChange = vi.fn();
  const utils = await renderWith(client, <Harness initial={p} onChange={onChange} replyId={opts.replyId} />, opts.url ?? "/p/p1", me);
  return { ...utils, client, list, create, del, lock, unlock, onChange };
}

const heading = () => document.getElementById("pf-post-replies-title")!;
const textarea = () => screen.getByRole("textbox", { name: "Reply text" }) as HTMLTextAreaElement;
const submitBtn = () => within(screen.getByRole("form", { name: "Reply to the post" })).getByRole("button", { name: "Reply" }) as HTMLButtonElement;

describe("PostThread load (F031 § 0.12)", () => {
  it("loads the whole thread with { page: 1, perPage: 200 }; empty thread", async () => {
    const { list } = await setup();
    expect(list).toHaveBeenCalledWith("p1", { page: 1, perPage: 200 }, expect.anything());
    const section = document.querySelector("section.pf-post-thread")!;
    expect(section.getAttribute("aria-labelledby")).toBe("pf-post-replies-title");
    expect(heading().textContent).toBe("Replies");
    expect(heading().tagName).toBe("H2");
    expect(heading().getAttribute("tabindex")).toBe("-1");
    const empty = screen.getByText("No replies yet.");
    expect(empty.className).toBe("pf-muted pf-post-thread__empty");
  });

  it("heading with a count, list oldest first", async () => {
    await setup({ replies: [reply("r1"), reply("r2", { author: kaiRef })] });
    expect(heading().textContent).toBe("Replies (2)");
    const items = document.querySelectorAll("ol.pf-post-thread__list > li > article.pf-post-reply");
    expect(Array.from(items).map((a) => a.id)).toEqual(["reply-r1", "reply-r2"]);
  });

  it("loading spinner, then the error with Retry", async () => {
    const d = deferred<Page<PostReply>>();
    let calls = 0;
    const { list } = await setup({
      replies: () => {
        calls++;
        return calls === 1 ? d.promise : Promise.resolve(pageOf([reply("r1")]));
      },
    });
    expect(screen.getByRole("status", { name: "Loading replies" })).toBeTruthy();
    await act(async () => d.reject(new Error("boom")));
    expect(screen.getByText("Couldn't load replies.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.getElementById("reply-r1")).not.toBeNull();
    expect(screen.queryByText("Couldn't load replies.")).toBeNull();
  });

  it("drops invalid items", async () => {
    await setup({ replies: [reply("r1"), { id: 3 } as unknown as PostReply] });
    expect(document.querySelectorAll("article.pf-post-reply")).toHaveLength(1);
  });
});

describe("PostReplyItem (F031 § 0.13)", () => {
  it("author link, Author badge, time link, Replying to, linkified body", async () => {
    await setup({
      replies: [
        reply("r1", { body: "Nice! https://example.com/x" }),
        reply("r2", { author: miaRef, byPostAuthor: true, replyTo: leoRef, createdAt: "2026-11-03T10:00:00.000Z" }),
      ],
    });
    const r1 = document.getElementById("reply-r1")!;
    expect(r1.getAttribute("tabindex")).toBe("-1");
    expect(r1.getAttribute("aria-labelledby")).toBe("reply-r1-author");
    const author = document.getElementById("reply-r1-author")!;
    expect(author.textContent).toBe("Leo");
    expect(author.getAttribute("href")).toBe("/u/leo");
    expect(author.className).toBe("pf-post-reply__author");
    const avatar = r1.querySelector(".pf-post-reply__avatar")!;
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.getAttribute("tabindex")).toBe("-1");
    expect(within(r1).queryByText("Author")).toBeNull();
    const time = r1.querySelector("time")!;
    const timeLink = time.closest("a")!;
    expect(timeLink.getAttribute("href")).toBe("/p/p1?reply=r1");
    expect(timeLink.getAttribute("title")).toBe(`${formatDate("2026-11-02T10:00:00.000Z")} · link to this reply`);
    expect(time.getAttribute("dateTime")).toBe("2026-11-02T10:00:00.000Z");
    const link = within(r1.querySelector(".pf-post__body") as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");

    const r2 = document.getElementById("reply-r2")!;
    const badge = within(r2).getByText("Author");
    expect(badge.className).toBe("pf-badge pf-badge--creator");
    const replyTo = r2.querySelector(".pf-post-reply__replyto")!;
    expect(replyTo.textContent).toBe("Replying to @leo");
    expect(within(replyTo as HTMLElement).getByRole("link", { name: "@leo" }).getAttribute("href")).toBe("/u/leo");
  });

  it("Report on replies: shown for non-authors (anonymous too), heading 'Report reply'", async () => {
    await setup({ me: leoUser, replies: [reply("r1"), reply("r2", { author: kaiRef })] });
    expect(within(document.getElementById("reply-r1")!).queryByRole("button", { name: /^Report/ })).toBeNull();
    fireEvent.click(within(document.getElementById("reply-r2")!).getByRole("button", { name: "Report reply by Kai" }));
    expect(screen.getByRole("dialog", { name: "Report reply" })).toBeTruthy();
  });

  it("anonymous: Report shown, no Reply or Delete", async () => {
    await setup({ replies: [reply("r1")] });
    const r1 = document.getElementById("reply-r1")!;
    expect(within(r1).getByRole("button", { name: "Report reply by Leo" })).toBeTruthy();
    expect(within(r1).queryByRole("button", { name: /^Reply/ })).toBeNull();
    expect(within(r1).queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});

describe("PostReplyForm (F031 § 0.14)", () => {
  it("label, placeholder, counter, is-over and disabled states", async () => {
    await setup({ me: leoUser });
    const form = screen.getByRole("form", { name: "Reply to the post" });
    expect(form.id).toBe("pf-post-reply-form");
    expect(form.className).toContain("pf-post-reply-form");
    const ta = textarea();
    expect(ta.getAttribute("placeholder")).toBe("Write a reply…");
    expect(ta.getAttribute("rows")).toBe("2");
    expect(ta.hasAttribute("maxlength")).toBe(false);
    const count = form.querySelector(".pf-post-composer__count")!;
    expect(ta.getAttribute("aria-describedby")).toBe(count.id);
    expect(count.textContent).toBe("0 / 500");
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(ta, { target: { value: "  hi  " } });
    expect(count.textContent).toBe("2 / 500");
    expect(submitBtn().disabled).toBe(false);
    fireEvent.change(ta, { target: { value: "x".repeat(503) } });
    expect(count.textContent).toBe("503 / 500 · 3 too many");
    expect(count.className).toContain("is-over");
    expect(submitBtn().disabled).toBe(true);
  });

  it("the 12-line and character checks send no request", async () => {
    const { create } = await setup({ me: leoUser });
    fireEvent.change(textarea(), { target: { value: Array.from({ length: 13 }, () => "a").join("\n") } });
    await act(async () => fireEvent.click(submitBtn()));
    expect(screen.getByRole("alert").textContent).toBe("Replies can have at most 12 lines.");
    fireEvent.change(textarea(), { target: { value: "a​b" } });
    await act(async () => fireEvent.click(submitBtn()));
    expect(screen.getByRole("alert").textContent).toBe("Remove tabs, control characters and invisible formatting characters.");
    expect(create).not.toHaveBeenCalled();
  });

  it("success: request body, append, clear, toast, focus, onPostChange with replyCount + 1", async () => {
    const { create, onChange } = await setup({ me: leoUser, replies: [reply("r1", { author: kaiRef })] });
    create.mockResolvedValue(reply("r9", { body: "hi\nthere" }));
    fireEvent.change(textarea(), { target: { value: "  hi\r\nthere " } });
    await act(async () => fireEvent.click(submitBtn()));
    expect(create).toHaveBeenCalledWith("p1", { body: "hi\nthere", replyToId: null });
    expect(Array.from(document.querySelectorAll("article.pf-post-reply")).map((a) => a.id)).toEqual(["reply-r1", "reply-r9"]);
    expect(textarea().value).toBe("");
    expect(await screen.findByText("Reply posted")).toBeTruthy();
    expect(document.activeElement).toBe(textarea());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p1", replyCount: 2 }));
    expect(heading().textContent).toBe("Replies (2)");
  });

  it("Ctrl+Enter submits", async () => {
    const { create } = await setup({ me: leoUser });
    create.mockResolvedValue(reply("r9"));
    fireEvent.change(textarea(), { target: { value: "yo" } });
    await act(async () => fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a 422 shows in the Alert; the lock 422 also marks the post locked", async () => {
    const { create, onChange } = await setup({ me: leoUser });
    create.mockRejectedValueOnce(new ApiError("validation", "This post has reached 200 replies", 422));
    fireEvent.change(textarea(), { target: { value: "yo" } });
    await act(async () => fireEvent.click(submitBtn()));
    expect(screen.getByRole("alert").textContent).toBe("This post has reached 200 replies");
    expect(onChange).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(new ApiError("validation", "Replies are turned off for this post", 422));
    await act(async () => fireEvent.click(submitBtn()));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p1", locked: true }));
    // Leo can't moderate: the form goes away and the notice shows.
    expect(screen.queryByRole("form", { name: "Reply to the post" })).toBeNull();
    expect(screen.getByText("Replies are turned off for this post.")).toBeTruthy();
  });

  it("Reply on a reply sets 'Replying to', focuses the textarea, keeps the text and sends replyToId; ✕ clears it", async () => {
    const { create } = await setup({ me: miaUser, post: socialPost("p1", { replyCount: 1, canDelete: true }), replies: [reply("r1")] });
    const scroll = vi.fn();
    const form = screen.getByRole("form", { name: "Reply to the post" });
    (form as HTMLElement & { scrollIntoView: unknown }).scrollIntoView = scroll;
    fireEvent.change(textarea(), { target: { value: "draft" } });
    const btn = within(document.getElementById("reply-r1")!).getByRole("button", { name: "Reply to Leo" });
    expect(btn.getAttribute("aria-controls")).toBe("pf-post-reply-form");
    await act(async () => fireEvent.click(btn));
    const line = form.querySelector(".pf-post-reply-form__replyto")!;
    expect(line.textContent).toContain("Replying to @leo");
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe("draft");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });

    create.mockResolvedValue(reply("r2", { author: miaRef, replyTo: leoRef, byPostAuthor: true }));
    await act(async () => fireEvent.click(submitBtn()));
    expect(create).toHaveBeenCalledWith("p1", { body: "draft", replyToId: "r1" });
    expect(form.querySelector(".pf-post-reply-form__replyto")).toBeNull();

    await act(async () => fireEvent.click(within(document.getElementById("reply-r1")!).getByRole("button", { name: "Reply to Leo" })));
    fireEvent.click(screen.getByRole("button", { name: "Stop replying to @leo" }));
    expect(form.querySelector(".pf-post-reply-form__replyto")).toBeNull();
    expect(document.activeElement).toBe(textarea());
  });

  it("replying to your own reply shows no 'Replying to'", async () => {
    await setup({ me: leoUser, replies: [reply("r1")] });
    await act(async () => fireEvent.click(within(document.getElementById("reply-r1")!).getByRole("button", { name: "Reply to Leo" })));
    expect(document.querySelector(".pf-post-reply-form__replyto")).toBeNull();
    expect(document.activeElement).toBe(textarea());
  });

  it("the answered reply was deleted meanwhile: clears 'Replying to', drops it, keeps the text, and the retry goes to the post", async () => {
    const { create, onChange } = await setup({ me: miaUser, post: socialPost("p1", { replyCount: 2, canDelete: true }), replies: [reply("r1"), reply("r2", { author: kaiRef })] });
    await act(async () => fireEvent.click(within(document.getElementById("reply-r1")!).getByRole("button", { name: "Reply to Leo" })));
    fireEvent.change(textarea(), { target: { value: "thanks!" } });
    create.mockRejectedValueOnce(new ApiError("not_found", "Reply not found", 404));
    await act(async () => fireEvent.click(submitBtn()));
    expect(create).toHaveBeenLastCalledWith("p1", { body: "thanks!", replyToId: "r1" });
    expect(screen.getByRole("alert").textContent).toBe("That reply was deleted. Your reply will go to the post.");
    expect(document.querySelector(".pf-post-reply-form__replyto")).toBeNull();
    expect(document.getElementById("reply-r1")).toBeNull();
    expect(document.getElementById("reply-r2")).not.toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ replyCount: 1 }));
    expect(heading().textContent).toBe("Replies (1)");
    expect(textarea().value).toBe("thanks!");

    create.mockResolvedValueOnce(reply("r9", { author: miaRef, byPostAuthor: true }));
    await act(async () => fireEvent.click(submitBtn()));
    expect(create).toHaveBeenLastCalledWith("p1", { body: "thanks!", replyToId: null });
    expect(document.getElementById("reply-r9")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a 404 'Post not found' (no reply target involved) shows the server message unchanged", async () => {
    const { create } = await setup({ me: leoUser, replies: [reply("r1", { author: kaiRef })] });
    create.mockRejectedValueOnce(new ApiError("not_found", "Post not found", 404));
    fireEvent.change(textarea(), { target: { value: "yo" } });
    await act(async () => fireEvent.click(submitBtn()));
    expect(screen.getByRole("alert").textContent).toBe("Post not found");
    expect(document.getElementById("reply-r1")).not.toBeNull();
  });
});

describe("Deleting a reply (F031 § 0.13)", () => {
  const three = () => [reply("r1", { canDelete: true }), reply("r2", { canDelete: true }), reply("r3", { canDelete: true })];

  async function deleteReply(id: string) {
    fireEvent.click(within(document.getElementById(`reply-${id}`)!).getByRole("button", { name: "Delete reply by Leo" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this reply?" });
    expect(within(dialog).getByText("This can't be undone.")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
  }

  it("dialog texts, toast, removal, replyCount - 1, focus on the next reply", async () => {
    const { del, onChange } = await setup({ me: leoUser, replies: three() });
    expect(within(document.getElementById("reply-r2")!).getByRole("button", { name: "Delete reply by Leo" }).getAttribute("aria-haspopup")).toBe("dialog");
    await deleteReply("r2");
    expect(del).toHaveBeenCalledWith("r2");
    expect(await screen.findByText("Reply deleted")).toBeTruthy();
    expect(document.getElementById("reply-r2")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ replyCount: 2 }));
    expect(document.activeElement).toBe(document.getElementById("reply-r3"));
  });

  it("focus on the previous reply when the last one is deleted", async () => {
    await setup({ me: leoUser, replies: three() });
    await deleteReply("r3");
    expect(document.activeElement).toBe(document.getElementById("reply-r2"));
  });

  it("focus on the textarea when no reply is left", async () => {
    await setup({ me: leoUser, replies: [reply("r1", { canDelete: true })] });
    await deleteReply("r1");
    expect(document.activeElement).toBe(textarea());
    expect(screen.getByText("No replies yet.")).toBeTruthy();
  });

  it("focus on the heading when no reply and no form is left", async () => {
    // Locked and Kai's reply: Kai can delete his reply (canDelete) but can't reply.
    await setup({
      me: leoUser,
      post: socialPost("p1", { replyCount: 1, locked: true }),
      replies: [reply("r1", { canDelete: true })],
    });
    expect(screen.queryByRole("form", { name: "Reply to the post" })).toBeNull();
    await deleteReply("r1");
    expect(document.activeElement).toBe(heading());
  });

  it("a failure toasts, closes the dialog and keeps the reply", async () => {
    const { del, onChange } = await setup({ me: leoUser, replies: three() });
    del.mockRejectedValue(new ApiError("forbidden", "Not allowed", 403));
    await deleteReply("r2");
    expect(await screen.findByText("Couldn't delete the reply")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.getElementById("reply-r2")).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Turn off replies (F031 § 0.12)", () => {
  it("is shown only with canDelete", async () => {
    await setup({ me: leoUser });
    expect(screen.queryByRole("button", { name: /replies$/ })).toBeNull();
  });

  it("toggles with toasts, aria-busy and onPostChange; focus stays", async () => {
    const d = deferred<Post>();
    const { lock, unlock, onChange } = await setup({ me: miaUser, post: socialPost("p1", { canDelete: true }) });
    lock.mockReturnValueOnce(d.promise);
    const btn = screen.getByRole("button", { name: "Turn off replies" });
    expect(btn.className).toBe("pf-btn pf-btn--ghost pf-btn--sm");
    expect(btn.querySelector("span")!.getAttribute("aria-hidden")).toBe("true");
    btn.focus();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(lock).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(socialPost("p1", { canDelete: true, locked: true })));
    expect(await screen.findByText("Replies turned off")).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true }));
    expect(btn.textContent).toBe("Turn on replies");
    expect(btn.hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(btn);
    // The author keeps the form, with the notice.
    expect(screen.getByText("Replies are turned off. You can still reply.")).toBeTruthy();
    const notice = screen.getByText("Replies are turned off. You can still reply.");
    expect(textarea().getAttribute("aria-describedby")!.split(" ")[0]).toBe(notice.id);
    expect(screen.getByText("Replies are turned off for this post.").className).toBe("pf-post-thread__locked pf-small");

    await act(async () => fireEvent.click(btn));
    expect(unlock).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("Replies turned on")).toBeTruthy();
    expect(btn.textContent).toBe("🔒 Turn off replies");
  });

  it("a failure toasts 'Couldn't change replies'", async () => {
    const { lock, onChange } = await setup({ me: miaUser, post: socialPost("p1", { canDelete: true }) });
    lock.mockRejectedValue(new ApiError("rate_limited", "Slow down", 429));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off replies" })));
    expect(await screen.findByText("Couldn't change replies")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Locked and anonymous form slot (F031 § 0.12)", () => {
  it("anonymous, not locked: 'Log in to reply.' with next = path and search", async () => {
    await setup({ url: "/p/p1?reply=r1" });
    const p = document.querySelector(".pf-post-thread__login")!;
    expect(p.textContent).toBe("Log in to reply.");
    expect(within(p as HTMLElement).getByRole("link", { name: "Log in" }).getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/p/p1?reply=r1")}`);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("anonymous, locked: only the notice", async () => {
    await setup({ post: socialPost("p1", { locked: true }) });
    expect(document.querySelector(".pf-post-thread__login")).toBeNull();
    expect(screen.getByText("Replies are turned off for this post.")).toBeTruthy();
  });

  it("signed in, locked, not canDelete: no form and no Reply buttons", async () => {
    await setup({ me: leoUser, post: socialPost("p1", { locked: true, replyCount: 1 }), replies: [reply("r1", { author: kaiRef })] });
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply to Kai" })).toBeNull();
  });

  it("admin on a locked post gets the form", async () => {
    await setup({ me: rootUser, post: socialPost("p1", { locked: true, canDelete: true }) });
    expect(screen.getByRole("form", { name: "Reply to the post" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on replies" })).toBeTruthy();
  });
});

describe("Deep links (F031 § 0.15)", () => {
  it("highlights, scrolls to and focuses the reply", async () => {
    const scroll = vi.fn();
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      await setup({ replies: [reply("r1"), reply("r2")], replyId: "r2" });
      const r2 = document.getElementById("reply-r2")!;
      expect(r2.className).toBe("pf-post-reply pf-post-reply--highlight");
      expect(document.getElementById("reply-r1")!.className).toBe("pf-post-reply");
      expect(document.activeElement).toBe(r2);
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });

  it("an unknown id shows 'That reply is no longer available.' above the list", async () => {
    await setup({ replies: [reply("r1")], replyId: "zz" });
    const gone = screen.getByText("That reply is no longer available.");
    expect(gone.getAttribute("role")).toBe("status");
    expect(gone.className).toBe("pf-muted pf-small pf-post-thread__gone");
    expect(gone.compareDocumentPosition(document.querySelector("ol.pf-post-thread__list")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.getElementById("reply-r1")).not.toBeNull();
  });

  it("waits for a pending load before deciding", async () => {
    const d = deferred<Page<PostReply>>();
    await setup({ replies: () => d.promise, replyId: "r1" });
    expect(screen.queryByText("That reply is no longer available.")).toBeNull();
    await act(async () => d.resolve(pageOf([reply("r1")])));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("reply-r1")));
  });
});
