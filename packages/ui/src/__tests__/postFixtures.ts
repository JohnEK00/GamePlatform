import type { Post, User, UserRef } from "../api/types";
import { game, summary } from "./collectionFixtures";

export const miaRef: UserRef = { id: "u7", username: "mia", displayName: "Mia", avatarUrl: null };
export const miaUser: User = { ...miaRef, bio: "", createdAt: "2024-03-15T12:00:00Z", role: "user", bannerUrl: null, links: [] };
export const leoUser: User = { id: "u8", username: "leo", displayName: "Leo", avatarUrl: null, bio: "", createdAt: "2025-01-01T00:00:00Z", role: "user" };
export const rootUser: User = { id: "u9", username: "root", displayName: "Root", avatarUrl: null, bio: "", createdAt: "2025-01-01T00:00:00Z", role: "admin" };

export function post(id: string, over: Partial<Post> = {}): Post {
  return {
    id,
    author: miaRef,
    body: `Post ${id}`,
    attachment: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    canDelete: false,
    path: `/p/${id}`,
    ...over,
  };
}

export const gameAttachment = (over: Parameters<typeof game>[2] = {}) => ({
  type: "game" as const,
  game: game("g1", "Space Dodge", over),
  collection: null,
});

export const collectionAttachment = () => ({
  type: "collection" as const,
  game: null,
  collection: summary("c1", "Cozy games", { gameCount: 3 }),
});

export function page<T>(items: T[], total = items.length, pageNo = 1, perPage = 20) {
  return { items, total, page: pageNo, perPage };
}
