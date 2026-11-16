import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Comment } from "../api/types";
import { CommentItem, type CommentItemProps } from "../components/CommentItem";
import { WebGameProviders } from "../WebGameApp";

const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function cm(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    gameId: "g1",
    author: alice,
    body: "FAQ",
    createdAt: "2026-11-15T10:00:00Z",
    parentId: null,
    replyTo: null,
    isCreator: false,
    hearts: 0,
    myHeart: false,
    creatorHeart: false,
    canDelete: true,
    pinned: false,
    locked: false,
    canModerate: true,
    ...over,
  };
}

function renderItem(props: Partial<CommentItemProps> & { comment: Comment }) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <CommentItem viewerId="u1" threadId={props.comment.parentId ?? props.comment.id} onReply={() => {}} onDelete={() => {}} {...props} />
      </MemoryRouter>
    </WebGameProviders>,
  );
}

describe("CommentItem F017 tools", () => {
  it("shows Pin and Lock after Delete and before Report, with ids and labels", () => {
    const onPin = vi.fn();
    const onLock = vi.fn();
    renderItem({ comment: cm(), onPin, onLock });
    const pin = screen.getByRole("button", { name: "Pin comment by Alice" });
    const lock = screen.getByRole("button", { name: "Lock replies to comment by Alice" });
    expect(pin.id).toBe("pin-btn-c1");
    expect(lock.id).toBe("lock-btn-c1");
    expect(pin.textContent).toBe("Pin");
    expect(lock.textContent).toBe("Lock");
    expect(pin.hasAttribute("aria-pressed")).toBe(false);
    const names = within(document.querySelector(".pf-comment__actions") as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.textContent!.trim());
    const at = (t: string) => names.findIndex((n) => n === t || n.endsWith(t));
    expect(at("Delete")).toBeLessThan(at("Pin"));
    expect(at("Pin")).toBeLessThan(at("Lock"));
    expect(at("Lock")).toBeLessThan(at("Report"));
    fireEvent.click(pin);
    fireEvent.click(lock);
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(onLock).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
  });

  it("Unpin / Unlock labels and badges when pinned and locked", () => {
    renderItem({ comment: cm({ pinned: true, locked: true }), onPin: () => {}, onLock: () => {} });
    expect(screen.getByRole("button", { name: "Unpin comment by Alice" }).textContent).toBe("Unpin");
    expect(screen.getByRole("button", { name: "Unlock replies to comment by Alice" }).textContent).toBe("Unlock");
    const pinned = screen.getByText("Pinned", { exact: false, selector: ".pf-badge" });
    expect(pinned.className).toContain("pf-badge--pinned");
    expect(pinned.textContent).toContain("Pinned");
    expect(pinned.querySelector("[aria-hidden=true]")!.textContent).toBe("📌");
    const locked = screen.getByText("Locked", { exact: false, selector: ".pf-badge" });
    expect(locked.className).toContain("pf-badge--locked");
    expect(locked.querySelector("[aria-hidden=true]")!.textContent).toBe("🔒");
  });

  it("no tools without canModerate, on replies, or without handlers", () => {
    const { unmount } = renderItem({ comment: cm({ canModerate: false }), onPin: () => {}, onLock: () => {} });
    expect(screen.queryByRole("button", { name: /^(Pin|Lock)/ })).toBeNull();
    unmount();
    const r = renderItem({ comment: cm({ id: "r1", parentId: "c1" }), isReply: true, onPin: () => {}, onLock: () => {} });
    expect(screen.queryByRole("button", { name: /^(Pin|Lock)/ })).toBeNull();
    r.unmount();
    renderItem({ comment: cm() });
    expect(screen.queryByRole("button", { name: /^(Pin|Lock)/ })).toBeNull();
  });

  it("ignores clicks while busy (not disabled) and hides Reply when replies are locked", () => {
    const onPin = vi.fn();
    renderItem({ comment: cm(), onPin, onLock: () => {}, pinBusy: true, repliesLocked: true });
    const pin = screen.getByRole("button", { name: "Pin comment by Alice" });
    expect((pin as HTMLButtonElement).disabled).toBe(false);
    expect(pin.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(pin);
    expect(onPin).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Reply to Alice" })).toBeNull();
  });
});
