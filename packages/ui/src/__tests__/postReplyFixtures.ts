// F031 fixtures: posts with the social fields, and replies. The F030 `postFixtures.ts` posts stay field-less.
import type { Post, PostReply, UserRef } from "../api/types";
import { leoUser, miaRef, post } from "./postFixtures";

export const leoRef: UserRef = { id: leoUser.id, username: leoUser.username, displayName: leoUser.displayName, avatarUrl: null };
export const kaiRef: UserRef = { id: "u10", username: "kai", displayName: "Kai", avatarUrl: null };

/** A post by Mia with the F031 fields (0 hearts, 0 replies, unlocked unless overridden). */
export function socialPost(id: string, over: Partial<Post> = {}): Post {
  return post(id, { hearts: 0, myHeart: false, replyCount: 0, locked: false, ...over });
}

export function reply(id: string, over: Partial<PostReply> = {}): PostReply {
  const postId = over.postId ?? "p1";
  return {
    id,
    postId,
    author: leoRef,
    replyTo: null,
    body: `Reply ${id}`,
    createdAt: "2026-11-02T10:00:00.000Z",
    byPostAuthor: false,
    canDelete: false,
    path: `/p/${postId}?reply=${id}`,
    ...over,
  };
}

export { miaRef };

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
