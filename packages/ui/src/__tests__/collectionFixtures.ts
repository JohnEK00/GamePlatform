import type { Collection, CollectionItem, CollectionSummary, GameSummary, MyCollection, User, UserRef } from "../api/types";

export const ana: UserRef = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null };
export const sam: UserRef = { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null };

export const anaUser: User = { ...ana, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
export const samUser: User = { ...sam, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
export const adminUser: User = { id: "u9", username: "root", displayName: "Root", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "admin" };

export function game(id: string, title: string, over: Partial<GameSummary> = {}): GameSummary {
  return {
    id,
    title,
    description: "",
    tags: [],
    owner: sam,
    thumbnailUrl: `/media/thumbnails/${id}.png`,
    plays: 12,
    ratingAvg: 4.5,
    ratingCount: 2,
    published: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    favorites: 0,
    playsWeek: 0,
    ...over,
  };
}

export function item(gameId: string, title: string | null, note = ""): CollectionItem {
  return { gameId, game: title === null ? null : game(gameId, title), note, addedAt: "2026-11-01T00:00:00Z" };
}

export function summary(id: string, title: string, over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id,
    title,
    description: "",
    visibility: "public",
    owner: ana,
    gameCount: 3,
    coverUrls: [],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    path: `/c/${id}`,
    ...over,
  };
}

export function collection(over: Partial<Collection> = {}): Collection {
  const items = over.items ?? [item("g1", "Space Dodge", "Best soundtrack"), item("g2", "Brick Breaker"), item("g3", "Pixel Peaks", "Hard!")];
  return {
    ...summary("c1", "Cozy games"),
    description: "Short and sweet.\nPlay these first.",
    gameCount: items.filter((i) => i.game).length,
    items,
    isOwner: false,
    canDelete: false,
    ...over,
  };
}

export function mine(id: string, title: string, over: Partial<MyCollection> = {}): MyCollection {
  return { ...summary(id, title), containsGame: false, itemCount: 2, ...over };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
