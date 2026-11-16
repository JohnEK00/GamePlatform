import type { Notification, User, UserRef } from "../api/types";

export const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

export const user = (id: string, displayName: string, username = displayName.toLowerCase()): UserRef => ({ id, username, displayName, avatarUrl: null });

export const mia = user("u2", "Mia");
export const noah = user("u3", "Noah");
export const ava = user("u4", "Ava");

export function notif(over: Partial<Notification> & { id: string }): Notification {
  return {
    kind: "comment",
    actors: [mia],
    actorCount: 1,
    eventCount: 1,
    game: { id: "g1", title: "Pixel Peaks", thumbnailUrl: null },
    commentId: "c1",
    excerpt: null,
    ownsThread: false,
    creatorHeart: false,
    read: false,
    createdAt: "2026-11-15T10:00:00.000Z",
    updatedAt: "2026-11-15T10:00:00.000Z",
    path: "/games/g1?comment=c1",
    ...over,
  };
}
