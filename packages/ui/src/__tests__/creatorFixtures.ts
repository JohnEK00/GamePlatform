import type { Creator, User } from "../api/types";

export const mia = { id: "u2", username: "mia", displayName: "Mia", avatarUrl: null };

export function creator(username: string, over: Partial<Creator> = {}): Creator {
  return {
    user: { id: `id-${username}`, username, displayName: username[0].toUpperCase() + username.slice(1), avatarUrl: null },
    bannerUrl: null,
    bioExcerpt: "",
    games: 1,
    plays: 0,
    followers: 0,
    isFollowing: false,
    firstPublishedAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

export const viewer: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
