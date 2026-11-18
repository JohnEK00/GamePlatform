import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Post, PostAttachment } from "../api/types";
import { PostCard } from "../components/PostCard";
import { formatDate } from "../util";
import { collectionAttachment, gameAttachment, leoUser, miaUser, post } from "./postFixtures";
import { makeClient, renderWith } from "./postRender";

afterEach(() => vi.restoreAllMocks());

async function show(p: Post, opts: { me?: typeof miaUser | null; onDeleted?: (p: Post) => void; feedId?: string } = {}) {
  const me = opts.me === undefined ? null : opts.me;
  const client = makeClient(me);
  const del = vi.spyOn(client, "deletePost").mockResolvedValue(undefined);
  const utils = await renderWith(client, <PostCard post={p} onDeleted={opts.onDeleted} feedId={opts.feedId} />, "/", me);
  const article = utils.container.querySelector<HTMLElement>("article.pf-post")!;
  return { ...utils, client, del, article };
}

describe("PostCard head and body (F030 section 0.13)", () => {
  it("shows the name link, @username and the time link to the permalink", async () => {
    const { article } = await show(post("p1"));
    expect(article.getAttribute("tabindex")).toBe("-1");
    const who = article.querySelector<HTMLElement>(".pf-post__who")!;
    expect(article.getAttribute("aria-labelledby")).toBe(who.id);
    const name = within(who).getByRole("link", { name: "Mia" });
    expect(name.getAttribute("href")).toBe("/u/mia");
    expect(name.querySelector("strong")!.textContent).toBe("Mia");
    expect(within(who).getByText("@mia")).toBeTruthy();
    const time = who.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe("2026-11-01T10:00:00.000Z");
    expect(time.getAttribute("title")).toBe(formatDate("2026-11-01T10:00:00.000Z"));
    expect(time.closest("a")!.getAttribute("href")).toBe("/p/p1");
    // The avatar link is hidden from AT and out of the tab order.
    const avatar = article.querySelector(".pf-post__avatar")!;
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.getAttribute("tabindex")).toBe("-1");
    // Not a feed item.
    expect(article.hasAttribute("data-feed-id")).toBe(false);
  });

  it("falls back to the username without a display name", async () => {
    const { article } = await show(post("p1", { author: { ...miaUser, displayName: "" } }));
    expect(within(article).getByRole("link", { name: "mia" })).toBeTruthy();
  });

  it("renders links with the safe attributes and sr-only text; the rest stays text", async () => {
    const { article } = await show(post("p1", { body: "New level! https://example.com/devlog.\n<b>bold</b> example.org" }));
    const body = article.querySelector<HTMLElement>("p.pf-post__body")!;
    const links = within(body).getAllByRole("link");
    expect(links).toHaveLength(1);
    const a = links[0];
    expect(a.getAttribute("href")).toBe("https://example.com/devlog");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    expect(a.firstChild!.textContent).toBe("https://example.com/devlog");
    expect(a.querySelector(".pf-sr-only")!.textContent).toBe(" (opens in a new tab)");
    // Newlines are kept in the text (the class gives white-space: pre-wrap); HTML is never parsed.
    expect(body.textContent).toBe("New level! https://example.com/devlog (opens in a new tab).\n<b>bold</b> example.org");
    expect(body.querySelector("b")).toBeNull();
    expect(body.className).toBe("pf-post__body");
  });

  it("adds data-kind and data-feed-id in the feed", async () => {
    const { article } = await show(post("p1"), { feedId: "42" });
    expect(article.getAttribute("data-kind")).toBe("postCreated");
    expect(article.getAttribute("data-feed-id")).toBe("42");
  });
});

describe("PostCard attachments", () => {
  it("a visible game: a card link with the thumbnail, title and owner", async () => {
    const { article } = await show(post("p1", { attachment: gameAttachment() }));
    const card = article.querySelector<HTMLAnchorElement>("a.pf-post-attachment")!;
    expect(card.getAttribute("href")).toBe("/games/g1");
    expect(card.querySelector("strong")!.textContent).toBe("Space Dodge");
    expect(card.textContent).toContain("by Sam");
    const img = card.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toBe("http://api.test/media/thumbnails/g1.png");
  });

  it("a visible collection: a card link with the cover, title, count and owner", async () => {
    const { article } = await show(post("p1", { attachment: collectionAttachment() }));
    const card = article.querySelector<HTMLAnchorElement>("a.pf-post-attachment")!;
    expect(card.getAttribute("href")).toBe("/c/c1");
    expect(card.querySelector(".pf-collection-cover")).not.toBeNull();
    expect(card.querySelector("strong")!.textContent).toBe("Cozy games");
    expect(card.textContent).toContain("3 games · by Ana");
  });

  it("one game in a collection reads '1 game'", async () => {
    const a = collectionAttachment();
    const { article } = await show(post("p1", { attachment: { ...a, collection: { ...a.collection, gameCount: 1 } } }));
    expect(article.querySelector(".pf-post-attachment")!.textContent).toContain("1 game · by Ana");
  });

  it("placeholders for targets the viewer can't see", async () => {
    const g = await show(post("p1", { attachment: { type: "game", game: null, collection: null } }));
    const gone = g.article.querySelector(".pf-post-attachment--gone")!;
    expect(gone.tagName).toBe("P");
    expect(gone.textContent).toBe("This game is no longer available.");
    g.unmount();
    const c = await show(post("p2", { attachment: { type: "collection", game: null, collection: null } }));
    expect(c.article.querySelector(".pf-post-attachment--gone")!.textContent).toBe("This collection is no longer available.");
  });

  it("an unknown attachment type renders nothing", async () => {
    const { article } = await show(post("p1", { attachment: { type: "image", game: null, collection: null } as unknown as PostAttachment }));
    expect(article.querySelector(".pf-post-attachment")).toBeNull();
  });

  it("no attachment renders nothing", async () => {
    const { article } = await show(post("p1"));
    expect(article.querySelector(".pf-post-attachment")).toBeNull();
  });
});

describe("PostCard actions (F030 sections 0.13 and 0.14)", () => {
  it("anonymous: Report, no Delete; Report prompts to log in", async () => {
    const { article } = await show(post("p1"));
    expect(within(article).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(article).getByRole("button", { name: "⚑ Report" }));
    expect(await screen.findByText("Log in to report content")).toBeTruthy();
  });

  it("another signed-in user: Report opens 'Report post'", async () => {
    const { article } = await show(post("p1"), { me: leoUser });
    fireEvent.click(within(article).getByRole("button", { name: "⚑ Report" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Report post");
  });

  it("the author without canDelete (stale data): neither action, so no actions row", async () => {
    const { article } = await show(post("p1"), { me: miaUser });
    expect(article.querySelector(".pf-post__actions")).toBeNull();
  });

  it("canDelete: Delete and no Report", async () => {
    const { article } = await show(post("p1", { canDelete: true }), { me: leoUser });
    expect(within(article).queryByRole("button", { name: "⚑ Report" })).toBeNull();
    const del = within(article).getByRole("button", { name: "Delete" });
    expect(del.getAttribute("aria-haspopup")).toBe("dialog");
    expect(del.className).toContain("pf-btn--danger-text");
  });

  it("delete: the confirm text, then the toast and onDeleted", async () => {
    const onDeleted = vi.fn();
    const p = post("p1", { canDelete: true });
    const { article, del } = await show(p, { me: miaUser, onDeleted });
    fireEvent.click(within(article).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this post?" });
    expect(within(dialog).getByText("It's removed from the profile and from followers' feeds. This can't be undone.")).toBeTruthy();
    // Cancel first: nothing happens.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(del).not.toHaveBeenCalled();

    fireEvent.click(within(article).getByRole("button", { name: "Delete" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    expect(del).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("Post deleted")).toBeTruthy();
    expect(onDeleted).toHaveBeenCalledWith(p);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed delete toasts the error, closes the dialog and keeps the post", async () => {
    const onDeleted = vi.fn();
    const { article, del } = await show(post("p1", { canDelete: true }), { me: miaUser, onDeleted });
    del.mockRejectedValue(new ApiError("forbidden", "Not allowed", 403));
    const opener = within(article).getByRole("button", { name: "Delete" });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    expect(await screen.findByText("Couldn't delete the post")).toBeTruthy();
    expect(screen.getByText("Not allowed")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onDeleted).not.toHaveBeenCalled();
    expect(article.isConnected).toBe(true);
    // Focus goes back to the Delete button.
    expect(document.activeElement).toBe(within(article).getByRole("button", { name: "Delete" }));
  });
});
