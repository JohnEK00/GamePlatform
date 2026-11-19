import { describe, expect, it } from "vitest";
import {
  hasPostSocial,
  isValidPostReply,
  POST_CHARS_MESSAGE,
  POST_LINES_MESSAGE,
  POST_REPLY_CAP,
  postReplyPath,
  repliesLinkLabel,
  repliesLinkText,
  REPLY_LINES_MESSAGE,
  validatePostBody,
} from "../posts";
import { post } from "./postFixtures";
import { reply, socialPost } from "./postReplyFixtures";

describe("F031 post helpers", () => {
  it("constants", () => {
    expect(POST_REPLY_CAP).toBe(200);
    expect(REPLY_LINES_MESSAGE).toBe("Replies can have at most 12 lines.");
  });

  it("postReplyPath encodes both ids", () => {
    expect(postReplyPath("p1", "r1")).toBe("/p/p1?reply=r1");
    expect(postReplyPath("a/b", "c&d=e")).toBe("/p/a%2Fb?reply=c%26d%3De");
  });

  it("repliesLinkText", () => {
    expect(repliesLinkText(0)).toBe("Reply");
    expect(repliesLinkText(1)).toBe("1 reply");
    expect(repliesLinkText(5)).toBe("5 replies");
    expect(repliesLinkText(-3)).toBe("Reply");
    expect(repliesLinkText(Number.NaN)).toBe("Reply");
  });

  it("repliesLinkLabel", () => {
    expect(repliesLinkLabel(0, "Mia")).toBe("Reply to the post by Mia");
    expect(repliesLinkLabel(1, "Mia")).toBe("1 reply to the post by Mia");
    expect(repliesLinkLabel(7, "Mia")).toBe("7 replies to the post by Mia");
  });

  it("validatePostBody takes the lines message; existing callers are unchanged", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => `l${i}`).join("\n");
    expect(validatePostBody(thirteen, REPLY_LINES_MESSAGE)).toBe(REPLY_LINES_MESSAGE);
    expect(validatePostBody(thirteen)).toBe(POST_LINES_MESSAGE);
    const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    expect(validatePostBody(twelve, REPLY_LINES_MESSAGE)).toBeNull();
    expect(validatePostBody("a\tb", REPLY_LINES_MESSAGE)).toBe(POST_CHARS_MESSAGE);
    // U+2028 can't be used to get around the line cap.
    expect(validatePostBody("a b", REPLY_LINES_MESSAGE)).toBe(POST_CHARS_MESSAGE);
  });

  it("hasPostSocial needs numeric hearts and replyCount", () => {
    expect(hasPostSocial(socialPost("p1"))).toBe(true);
    expect(hasPostSocial(post("p1"))).toBe(false);
    expect(hasPostSocial(post("p1", { hearts: 1 }))).toBe(false);
    expect(hasPostSocial(post("p1", { replyCount: 1 }))).toBe(false);
    expect(hasPostSocial(null)).toBe(false);
  });

  it("isValidPostReply", () => {
    expect(isValidPostReply(reply("r1"))).toBe(true);
    expect(isValidPostReply(null)).toBe(false);
    expect(isValidPostReply("r1")).toBe(false);
    for (const k of ["id", "postId", "body", "createdAt", "path"] as const) {
      expect(isValidPostReply({ ...reply("r1"), [k]: 3 })).toBe(false);
    }
    expect(isValidPostReply({ ...reply("r1"), author: null })).toBe(false);
    expect(isValidPostReply({ ...reply("r1"), author: { id: "u1" } })).toBe(false);
  });
});
