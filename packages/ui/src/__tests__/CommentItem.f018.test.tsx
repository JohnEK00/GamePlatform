import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Comment } from "../api/types";
import { CommentItem, type CommentItemProps } from "../components/CommentItem";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function cm(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    gameId: "g1",
    author: alice,
    body: "Long thread",
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
    threadMuted: false,
    ...over,
  };
}

async function setup(props: Partial<CommentItemProps> & { comment: Comment }, opts: { muteFails?: boolean } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 3, latestAt: null, pollAfterSecs: 60 });
  const mute = vi
    .spyOn(client, "muteThread")
    .mockImplementation(async () => (opts.muteFails ? Promise.reject(new ApiError("validation", "Only whole threads can be muted", 422)) : { muted: true, unread: 1 }));
  const unmute = vi.spyOn(client, "unmuteThread").mockResolvedValue({ muted: false, unread: 1 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <CommentItem viewerId="u1" threadId={props.comment.parentId ?? props.comment.id} onReply={() => {}} {...props} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  await act(async () => {});
  return { mute, unmute };
}

const muteBtn = () => screen.queryByRole("button", { name: /^(Un)?[Mm]ute thread by Alice$/ });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CommentItem: Mute thread (F018)", () => {
  it("shows on top-level comments and toggles with toasts and Undo", async () => {
    const { mute, unmute } = await setup({ comment: cm() });
    const b = muteBtn()!;
    expect(b.textContent).toBe("Mute thread");
    expect(b.getAttribute("aria-label")).toBe("Mute thread by Alice");
    expect(b.hasAttribute("aria-pressed")).toBe(false);
    expect(b.className).toContain("pf-linkbtn");
    fireEvent.click(b);
    expect(mute).toHaveBeenCalledWith("c1");
    expect(muteBtn()!.textContent).toBe("Unmute thread");
    expect(muteBtn()!.getAttribute("aria-label")).toBe("Unmute thread by Alice");
    expect(await screen.findByText("Thread muted. Replies, hearts and pins in it won't notify you.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(unmute).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("Thread unmuted.")).toBeTruthy();
    expect(muteBtn()!.textContent).toBe("Mute thread");
  });

  it("starts as Unmute thread when threadMuted is true", async () => {
    await setup({ comment: cm({ threadMuted: true }) });
    expect(muteBtn()!.textContent).toBe("Unmute thread");
    expect(muteBtn()!.getAttribute("aria-label")).toBe("Unmute thread by Alice");
  });

  it("never shows on replies, without the field (older server) or for anonymous viewers", async () => {
    await setup({ comment: cm({ id: "r1", parentId: "c1" }), isReply: true });
    expect(muteBtn()).toBeNull();
  });

  it("is hidden when the server omits threadMuted", async () => {
    await setup({ comment: cm({ threadMuted: undefined }) });
    expect(muteBtn()).toBeNull();
  });

  it("is hidden for anonymous viewers", async () => {
    await setup({ comment: cm(), viewerId: null });
    expect(muteBtn()).toBeNull();
  });

  it("reverts on error", async () => {
    await setup({ comment: cm() }, { muteFails: true });
    fireEvent.click(muteBtn()!);
    expect(await screen.findByText("Only whole threads can be muted")).toBeTruthy();
    expect(muteBtn()!.textContent).toBe("Mute thread");
  });
});
