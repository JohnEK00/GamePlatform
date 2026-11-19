import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Post, User } from "../api/types";
import { PostCard } from "../components/PostCard";
import { ReportButton } from "../components/Report";
import { leoUser, miaUser, post, rootUser } from "./postFixtures";
import { socialPost } from "./postReplyFixtures";
import { makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

async function show(p: Post, me: User | null = null, inThread = false) {
  const client = makeClient(me);
  const heart = vi.spyOn(client, "setPostHeart").mockResolvedValue({ hearted: true, hearts: (p.hearts ?? 0) + 1 });
  const utils = await renderWith(client, <PostCard post={p} inThread={inThread} />, "/", me);
  const article = utils.container.querySelector<HTMLElement>("article.pf-post")!;
  return { ...utils, client, heart, article };
}

describe("PostCard per-post action names (F031 § 0.11 item 3)", () => {
  for (const [label, make] of [
    ["F030 fixture", (o: Partial<Post>) => post("p1", o)],
    ["F031 fixture", (o: Partial<Post>) => socialPost("p1", o)],
  ] as const) {
    it(`${label}: Delete is named 'Delete post by Mia'`, async () => {
      const { article } = await show(make({ canDelete: true }), miaUser);
      const del = within(article).getByRole("button", { name: "Delete post by Mia" });
      expect(del.textContent).toBe("Delete");
      expect(del.getAttribute("aria-haspopup")).toBe("dialog");
    });

    it(`${label}: Report is named 'Report post by Mia'`, async () => {
      const { article } = await show(make({}), leoUser);
      const rep = within(article).getByRole("button", { name: "Report post by Mia" });
      expect(rep.textContent).toBe("⚑ Report");
      fireEvent.click(rep);
      expect(screen.getByRole("dialog", { name: "Report post" })).toBeTruthy();
    });
  }

  it("a ReportButton without ariaLabel renders no aria-label", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <ReportButton targetType="comment" targetId="c1" />);
    const btn = container.querySelector("button")!;
    expect(btn.hasAttribute("aria-label")).toBe(false);
    expect(btn.textContent).toBe("Report");
  });
});

describe("PostCard heart and replies link (F031 § 0.11)", () => {
  it("an F030 post (no fields) renders no heart and no replies link", async () => {
    const { article } = await show(post("p1"), leoUser);
    expect(article.querySelector(".pf-heart")).toBeNull();
    expect(article.querySelector(".pf-post__replies")).toBeNull();
  });

  it("another signed-in user gets an interactive heart that calls setPostHeart", async () => {
    const { article, heart } = await show(socialPost("p1", { hearts: 2 }), leoUser);
    const btn = within(article).getByRole("button", { name: "Heart post by Mia, 2 hearts" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(btn));
    expect(heart).toHaveBeenCalledWith("p1", true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Heart post by Mia, 3 hearts");
  });

  it("the actions row order is heart, replies link, then Report", async () => {
    const { article } = await show(socialPost("p1", { hearts: 1, replyCount: 2 }), leoUser);
    const row = article.querySelector(".pf-post__actions")!;
    const names = Array.from(row.querySelectorAll("button, a")).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Heart post by Mia, 1 heart", "2 replies to the post by Mia", "Report post by Mia"]);
  });

  it("the author and anonymous viewers see a static count, and none at 0", async () => {
    const { article, unmount } = await show(socialPost("p1", { hearts: 2, canDelete: true }), miaUser);
    expect(within(article).queryByRole("button", { name: /^Heart post/ })).toBeNull();
    expect(within(article).getByRole("img", { name: "2 hearts" })).toBeTruthy();
    unmount();
    localStorage.clear();
    const anon = await show(socialPost("p2", { hearts: 0 }), null);
    expect(anon.article.querySelector(".pf-heart")).toBeNull();
    // The row is still rendered (replies link and Report).
    expect(anon.article.querySelector(".pf-post__actions")).not.toBeNull();
  });

  it("an admin (not the author) gets an interactive heart and Delete", async () => {
    const { article } = await show(socialPost("p1", { canDelete: true }), rootUser);
    expect(within(article).getByRole("button", { name: "Heart post by Mia" })).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Delete post by Mia" })).toBeTruthy();
  });

  it("replies link texts, labels and href", async () => {
    const cases: [number, string, string][] = [
      [0, "Reply", "Reply to the post by Mia"],
      [1, "1 reply", "1 reply to the post by Mia"],
      [5, "5 replies", "5 replies to the post by Mia"],
    ];
    for (const [n, text, label] of cases) {
      const { article, unmount } = await show(socialPost("a/b", { replyCount: n }));
      const link = within(article).getByRole("link", { name: label });
      expect(link.textContent).toBe(`💬 ${text}`);
      expect(link.className).toBe("pf-linkbtn pf-post__replies");
      expect(link.getAttribute("href")).toBe("/p/a%2Fb");
      expect(link.querySelector("span")!.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });

  it("the link is hidden when locked with no replies, shown when locked with replies", async () => {
    const a = await show(socialPost("p1", { locked: true, replyCount: 0 }));
    expect(a.article.querySelector(".pf-post__replies")).toBeNull();
    a.unmount();
    const b = await show(socialPost("p1", { locked: true, replyCount: 3 }));
    expect(within(b.article).getByRole("link", { name: "3 replies to the post by Mia" })).toBeTruthy();
  });

  it("inThread hides the link but keeps the heart", async () => {
    const { article } = await show(socialPost("p1", { replyCount: 3, hearts: 1 }), leoUser, true);
    expect(article.querySelector(".pf-post__replies")).toBeNull();
    expect(within(article).getByRole("button", { name: "Heart post by Mia, 1 heart" })).toBeTruthy();
  });
});
