import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Notification } from "../api/types";
import { NotificationItem } from "../components/NotificationItem";
import { WebGameProviders } from "../WebGameApp";
import { notif } from "./notifFixtures";

const base = (over: Partial<Notification> & { id: string }): Notification =>
  notif({ game: null, commentId: null, threadId: null, collection: null, screenshot: null, postId: "p1", ...over });

function renderItem(item: Notification, showMute = false) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const onMute = vi.fn();
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <ul>
          <NotificationItem item={item} variant="page" showMute={showMute} onMute={onMute} />
        </ul>
      </MemoryRouter>
    </WebGameProviders>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("NotificationItem post kinds (F031 § 0.9)", () => {
  it("postReply: link to the reply, summary, excerpt and the 💬 glyph; no Mute", () => {
    const { container } = renderItem(
      base({ id: "1", kind: "postReply", ownsThread: true, excerpt: "Can't wait for world 3!", path: "/p/p1?reply=r1" }),
      true,
    );
    const links = container.querySelectorAll("li a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/p/p1?reply=r1");
    expect(container.querySelector(".pf-notif__text")!.textContent).toBe("Unread: Mia replied to your post");
    expect(container.querySelector(".pf-notif__excerpt")!.textContent).toBe("“Can't wait for world 3!”");
    const glyph = container.querySelector(".pf-notif__kind.pf-notif__kind--post-reply")!;
    expect(glyph.textContent).toBe("💬");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".pf-notif__kind--post-heart")).toBeNull();
    expect(container.querySelector(".pf-notif__mute")).toBeNull();
  });

  it("postHeart: link to the post, summary, excerpt and the ♥ glyph", () => {
    const { container } = renderItem(base({ id: "2", kind: "postHeart", excerpt: "New level!", path: "/p/p1", read: true }), true);
    expect(container.querySelector("li a")!.getAttribute("href")).toBe("/p/p1");
    expect(container.querySelector(".pf-notif__text")!.textContent).toBe("Mia hearted your post");
    expect(container.querySelector(".pf-notif__excerpt")!.textContent).toBe("“New level!”");
    const glyph = container.querySelector(".pf-notif__kind.pf-notif__kind--post-heart")!;
    expect(glyph.textContent).toBe("♥");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    // Not the comment "♥ Creator" mark.
    expect(container.querySelector(".pf-heart-creator")).toBeNull();
    expect(container.querySelector(".pf-notif__mute")).toBeNull();
  });
});
