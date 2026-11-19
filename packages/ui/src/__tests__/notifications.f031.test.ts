import { describe, expect, it } from "vitest";
import type { Notification } from "../api/types";
import { isKnownNotification, muteActionFor, NOTIFICATION_KINDS, notificationParts, notificationText, osNotificationText, osNotificationsFor } from "../notifications";
import { ava, mia, noah, notif } from "./notifFixtures";

const postReply = (over: Partial<Notification> = {}): Notification =>
  notif({
    id: "31",
    kind: "postReply",
    game: null,
    commentId: null,
    threadId: null,
    collection: null,
    screenshot: null,
    postId: "p1",
    ownsThread: true,
    excerpt: "Can't wait for world 3!",
    path: "/p/p1?reply=r1",
    ...over,
  });

const postHeart = (over: Partial<Notification> = {}): Notification =>
  postReply({ id: "32", kind: "postHeart", ownsThread: false, excerpt: "New level!", path: "/p/p1", ...over });

describe("F031 notification summaries (spec § 0.9)", () => {
  it("both kinds are known", () => {
    expect(NOTIFICATION_KINDS).toContain("postReply");
    expect(NOTIFICATION_KINDS).toContain("postHeart");
    expect(isKnownNotification(postReply())).toBe(true);
    expect(isKnownNotification(postHeart())).toBe(true);
  });

  it("postReply, ownsThread", () => {
    expect(notificationText(postReply())).toBe("Mia replied to your post");
    expect(notificationText(postReply({ eventCount: 3 }))).toBe("Mia replied 3 times to your post");
    expect(notificationText(postReply({ actors: [mia, noah], actorCount: 2, eventCount: 4 }))).toBe("Mia and Noah replied to your post");
    expect(notificationText(postReply({ actors: [mia, noah, ava], actorCount: 3, eventCount: 3 }))).toBe("Mia and 2 others replied to your post");
    expect(notificationText(postReply({ actors: [mia, noah], actorCount: 2, eventCount: 2 }))).not.toContain("times");
  });

  it("postReply, not ownsThread", () => {
    expect(notificationText(postReply({ ownsThread: false }))).toBe("Mia replied to you on a post");
    expect(notificationText(postReply({ ownsThread: false, eventCount: 3 }))).toBe("Mia replied 3 times to you on a post");
    expect(notificationText(postReply({ ownsThread: false, actors: [mia, noah], actorCount: 2, eventCount: 2 }))).toBe(
      "Mia and Noah replied to you on a post",
    );
    expect(notificationText(postReply({ ownsThread: false, actors: [mia, noah, ava], actorCount: 3, eventCount: 5 }))).toBe(
      "Mia and 2 others replied to you on a post",
    );
  });

  it("postHeart", () => {
    expect(notificationText(postHeart())).toBe("Mia hearted your post");
    expect(notificationText(postHeart({ actors: [mia, noah], actorCount: 2, eventCount: 2 }))).toBe("Mia and Noah hearted your post");
    expect(notificationText(postHeart({ actors: [mia, noah, ava], actorCount: 3, eventCount: 3 }))).toBe("Mia and 2 others hearted your post");
    expect(notificationText(postHeart({ actors: [mia, noah], actorCount: 4, eventCount: 4 }))).toBe("Mia and 3 others hearted your post");
  });

  it("names are name parts; there are no title parts", () => {
    const parts = notificationParts(postReply({ actors: [mia, noah], actorCount: 2, eventCount: 2 }));
    expect(parts.filter((p) => p.type === "name").map((p) => p.text)).toEqual(["Mia", "Noah"]);
    expect(parts.some((p) => p.type === "title")).toBe(false);
    expect(notificationParts(postHeart()).some((p) => p.type === "title")).toBe(false);
  });

  it("muteActionFor is null for both, even with a game or threadId", () => {
    expect(muteActionFor(postReply())).toBeNull();
    expect(muteActionFor(postHeart())).toBeNull();
    expect(muteActionFor(postReply({ threadId: "c1", game: { id: "g1", title: "X", thumbnailUrl: null } }))).toBeNull();
  });

  it("osNotificationText equals notificationText and never contains the excerpt", () => {
    for (const n of [postReply(), postReply({ ownsThread: false, eventCount: 2 }), postHeart()]) {
      expect(osNotificationText(n)).toBe(notificationText(n));
      expect(osNotificationText(n)).not.toContain(n.excerpt!);
    }
    expect(osNotificationsFor([postReply()])[0].body).toBe("Mia replied to your post");
  });
});
