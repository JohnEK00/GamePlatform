// Review 12 (REVIEW-2026-11-19-12) frontend findings L1, L2 and L3.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Creator, Page, Post, PostReply } from "../api/types";
import { PostThread } from "../components/PostThread";
import { CreatorsPage } from "../pages/CreatorsPage";
import { creator } from "./creatorFixtures";
import { leoUser, miaUser } from "./postFixtures";
import { kaiRef, reply, socialPost } from "./postReplyFixtures";
import { currentLocation, makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const NEXT = `Next ${String.fromCodePoint(0x203a)}`;
const pageOf = (items: PostReply[]): Page<PostReply> => ({ items, total: items.length, page: 1, perPage: 200 });

function Harness({ initial }: { initial: Post }) {
  const [p, setP] = useState(initial);
  return <PostThread post={p} onPostChange={setP} />;
}

describe("L1: a reply refused because the post was locked meanwhile", () => {
  it("non-moderator: focus moves to the status notice and the typed text stays readable", async () => {
    const client = makeClient(leoUser);
    vi.spyOn(client, "listPostReplies").mockResolvedValue(pageOf([]));
    vi.spyOn(client, "createPostReply").mockRejectedValue(new ApiError("validation", "Replies are turned off for this post", 422));
    await renderWith(client, <Harness initial={socialPost("p1", { replyCount: 0 })} />, "/p/p1", leoUser);
    const ta = screen.getByRole("textbox", { name: "Reply text" });
    fireEvent.change(ta, { target: { value: "hello there" } });
    ta.focus();
    await act(async () => fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true }));

    expect(screen.queryByRole("form", { name: "Reply to the post" })).toBeNull();
    const notice = document.getElementById("pf-post-thread-locked")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("tabindex")).toBe("-1");
    expect(notice.textContent).toContain("Replies are turned off for this post.");
    expect(document.activeElement).toBe(notice);
    expect(document.activeElement).not.toBe(document.body);
    const kept = screen.getByRole("textbox", { name: "Your reply wasn't posted. Here is your text:" }) as HTMLTextAreaElement;
    expect(kept.readOnly).toBe(true);
    expect(kept.value).toBe("hello there");
  });

  it("the notice is a status message on a post that loads locked, with no unsent text", async () => {
    const client = makeClient(leoUser);
    vi.spyOn(client, "listPostReplies").mockResolvedValue(pageOf([]));
    await renderWith(client, <Harness initial={socialPost("p1", { locked: true })} />, "/p/p1", leoUser);
    expect(document.getElementById("pf-post-thread-locked")!.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a moderator keeps the form, the text and the Alert", async () => {
    const client = makeClient(miaUser);
    vi.spyOn(client, "listPostReplies").mockResolvedValue(pageOf([]));
    vi.spyOn(client, "createPostReply").mockRejectedValue(new ApiError("validation", "Replies are turned off for this post", 422));
    await renderWith(client, <Harness initial={socialPost("p1", { canDelete: true })} />, "/p/p1", miaUser);
    const ta = screen.getByRole("textbox", { name: "Reply text" }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "still here" } });
    await act(async () => fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true }));
    expect(screen.getByRole("form", { name: "Reply to the post" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Reply text" }) as HTMLTextAreaElement).value).toBe("still here");
    expect(screen.getByRole("alert").textContent).toBe("Replies are turned off for this post");
    expect(screen.queryByRole("textbox", { name: /wasn't posted/ })).toBeNull();
  });
});

describe("L2: /creators pagination keeps focus", () => {
  it("the pager stays mounted while the next page loads; focus moves to the h1", async () => {
    const client = makeClient(null);
    let resolveNext: (() => void) | null = null;
    vi.spyOn(client, "listCreators").mockImplementation(async (q) => {
      const n = q?.page ?? 1;
      const items = Array.from({ length: 24 }, (_, i) => creator(`u${n * 100 + i}`));
      if (n === 1) return { items, total: 60, page: 1, perPage: 24 };
      return new Promise<Page<Creator>>((r) => {
        resolveNext = () => r({ items, total: 60, page: 2, perPage: 24 });
      });
    });
    await renderWith(
      client,
      <Routes>
        <Route path="/creators" element={<CreatorsPage />} />
      </Routes>,
      "/creators",
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Creators" });
    expect(h1.getAttribute("tabindex")).toBe("-1");
    const next = within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("button", { name: NEXT });
    next.focus();
    await act(async () => fireEvent.click(next));
    expect(currentLocation()).toBe("/creators?page=2");
    // While page 2 loads: the pager is still there and focus is on the heading, not <body>.
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
    expect(document.activeElement).toBe(h1);
    await act(async () => resolveNext!());
    await waitFor(() => expect(screen.getByRole("button", { name: "2" }).getAttribute("aria-current")).toBe("page"));
    expect(document.activeElement).toBe(h1);
  });

  it("an error hides the pager", async () => {
    const client = makeClient(null);
    vi.spyOn(client, "listCreators").mockRejectedValue(new Error("boom"));
    await renderWith(
      client,
      <Routes>
        <Route path="/creators" element={<CreatorsPage />} />
      </Routes>,
      "/creators",
    );
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });
});

describe("L3: reply actions are named per reply", () => {
  it("Delete reply by {name} and Report reply by {name}", async () => {
    const client = makeClient(leoUser);
    vi.spyOn(client, "listPostReplies").mockResolvedValue(
      pageOf([reply("r1", { author: kaiRef, canDelete: true }), reply("r2", { author: { ...kaiRef, id: "u11", username: "zed", displayName: "" } })]),
    );
    await renderWith(client, <Harness initial={socialPost("p1", { replyCount: 2 })} />, "/p/p1", leoUser);
    const r1 = document.getElementById("reply-r1")!;
    expect(within(r1).getByRole("button", { name: "Delete reply by Kai" }).textContent).toBe("Delete");
    expect(within(r1).getByRole("button", { name: "Report reply by Kai" }).textContent).toBe("Report");
    // The name falls back to the username.
    const r2 = document.getElementById("reply-r2")!;
    expect(within(r2).getByRole("button", { name: "Report reply by zed" })).toBeTruthy();
    expect(within(r2).queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});
