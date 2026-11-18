// Kept ASCII-only: non-ASCII characters are built with String.fromCodePoint.
import { describe, expect, it } from "vitest";
import {
  isValidPost,
  linkifyPost,
  normalizePostBody,
  parseAttachParam,
  POST_CHARS_MESSAGE,
  POST_LINES_MESSAGE,
  postComposePath,
  postLength,
  postPath,
  validatePostBody,
  type PostSegment,
} from "../posts";
import { postShareUrl } from "../share";
import { post } from "./postFixtures";

const cp = (...n: number[]) => String.fromCodePoint(...n);
const t = (text: string): PostSegment => ({ type: "text", text });
const l = (url: string): PostSegment => ({ type: "link", text: url, href: url });

describe("linkifyPost (F030 section 0.4)", () => {
  const cases: [string, string, PostSegment[]][] = [
    ["spec: trailing period", "see https://a.com.", [t("see "), l("https://a.com"), t(".")]],
    ["spec: balanced parens kept, final paren is text", "(https://a.com/x_(y))", [t("("), l("https://a.com/x_(y)"), t(")")]],
    ["spec: stops before a comma", "x https://a.com/?q=1#h, y", [t("x "), l("https://a.com/?q=1#h"), t(", y")]],
    ["spec: no dot in the host", "http://localhost", [t("http://localhost")]],
    ["spec: javascript: is text", "javascript:alert(1)", [t("javascript:alert(1)")]],
    ["spec: non-ASCII host is text", `https://ex${cp(0xe4)}mple.com`, [t(`https://ex${cp(0xe4)}mple.com`)]],
    ["spec: not after a boundary", "ahttps://a.com", [t("ahttps://a.com")]],
    ["spec: double quotes stripped", '"https://a.com"', [t('"'), l("https://a.com"), t('"')]],
    ["spec: upper-case scheme", "HTTPS://A.com", [l("HTTPS://A.com")]],
    ["empty body", "", []],
    ["plain text only", "hello world", [t("hello world")]],
    ["bare domain stays text", "visit example.com now", [t("visit example.com now")]],
    ["mentions and tags stay text", "@mia #cozy", [t("@mia #cozy")]],
    ["URL alone", "https://a.com", [l("https://a.com")]],
    ["http scheme", "http://a.com/x", [l("http://a.com/x")]],
    ["after a newline", "line one\nhttps://a.com/two", [t("line one\n"), l("https://a.com/two")]],
    ["after an opening bracket", "[https://a.com]", [t("["), l("https://a.com"), t("]")]],
    ["after an opening brace", "{https://a.com}", [t("{"), l("https://a.com"), t("}")]],
    ["after an angle bracket", "<https://a.com>", [t("<"), l("https://a.com"), t(">")]],
    ["after a single quote", "'https://a.com'", [t("'"), l("https://a.com"), t("'")]],
    ["after a colon is not a boundary", "link:https://a.com", [t("link:https://a.com")]],
    ["several trailing characters", "wow https://a.com/x?!.", [t("wow "), l("https://a.com/x"), t("?!.")]],
    ["paren then period", "(see https://a.com).", [t("(see "), l("https://a.com"), t(").")]],
    ["period then unbalanced paren", "(https://a.com.)", [t("("), l("https://a.com"), t(".)")]],
    ["balanced parens alone stay", "https://en.wikipedia.org/wiki/Foo_(bar)", [l("https://en.wikipedia.org/wiki/Foo_(bar)")]],
    ["two links", "https://a.com and https://b.org/x", [l("https://a.com"), t(" and "), l("https://b.org/x")]],
    ["adjacent links separated by a space", "https://a.com https://b.com", [l("https://a.com"), t(" "), l("https://b.com")]],
    ["port and path", "at https://a.com:8080/p.", [t("at "), l("https://a.com:8080/p"), t(".")]],
    ["credentials are text", "https://user:pw@a.com/x", [t("https://user:pw@a.com/x")]],
    ["host starting with a dot is text", "https://.a.com", [t("https://.a.com")]],
    ["only a scheme and a dot is text", "https://.", [t("https://.")]],
    ["data: URL is text", "data:text/html,hi", [t("data:text/html,hi")]],
    ["mailto is text", "mailto:a@b.com", [t("mailto:a@b.com")]],
    ["ftp is text", "ftp://a.com", [t("ftp://a.com")]],
    ["scheme without slashes is text", "https:a.com", [t("https:a.com")]],
    ["unsafe candidate keeps its trailing characters as text", "go http://localhost.", [t("go http://localhost.")]],
    ["text before and after", "a https://a.com b", [t("a "), l("https://a.com"), t(" b")]],
    ["tab is whitespace boundary", "a\thttps://a.com", [t("a\t"), l("https://a.com")]],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(linkifyPost(input)).toEqual(expected);
  });

  it("joins back to the original text", () => {
    for (const [, input] of cases) expect(linkifyPost(input).map((s) => s.text).join("")).toBe(input);
  });

  it("a 200-character URL is a link, a 201-character one is text", () => {
    const base = "https://a.com/";
    const u200 = base + "x".repeat(200 - base.length);
    const u201 = u200 + "x";
    expect(u200.length).toBe(200);
    expect(linkifyPost(u200)).toEqual([l(u200)]);
    expect(linkifyPost(`see ${u201}`)).toEqual([t(`see ${u201}`)]);
  });

  it("a URL with non-ASCII in the path is text (printable ASCII only)", () => {
    const s = `https://a.com/${cp(0x1f600)}`;
    expect(linkifyPost(s)).toEqual([t(s)]);
  });

  it("is stateless between calls (global regex)", () => {
    expect(linkifyPost("https://a.com")).toEqual([l("https://a.com")]);
    expect(linkifyPost("https://a.com")).toEqual([l("https://a.com")]);
  });

  it("non-string input gives no segments", () => {
    expect(linkifyPost(undefined as unknown as string)).toEqual([]);
  });
});

describe("normalizePostBody / postLength", () => {
  it("turns CRLF and CR into LF, then trims", () => {
    expect(normalizePostBody("  hi\r\nthere\rnow  ")).toBe("hi\nthere\nnow");
    expect(normalizePostBody("\n\n a \n")).toBe("a");
  });

  it("counts code points of the normalised text", () => {
    expect(postLength(cp(0x1f600, 0x1f600))).toBe(2);
    expect(postLength("  ab  ")).toBe(2);
    expect(postLength("a\r\nb")).toBe(3);
    expect(postLength("")).toBe(0);
    expect(postLength(cp(0xe9).repeat(501))).toBe(501);
  });
});

describe("validatePostBody", () => {
  it("accepts plain text with newlines", () => {
    expect(validatePostBody("hello")).toBeNull();
    expect(validatePostBody("a\nb")).toBeNull();
    expect(validatePostBody("\n")).toBeNull();
    expect(validatePostBody(Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"))).toBeNull();
  });

  it("rejects more than 12 lines", () => {
    expect(validatePostBody(Array.from({ length: 13 }, (_, i) => `l${i}`).join("\n"))).toBe(POST_LINES_MESSAGE);
    expect(POST_LINES_MESSAGE).toBe("Posts can have at most 12 lines.");
  });

  it("counts lines after the trim (surrounding blank lines don't count)", () => {
    expect(validatePostBody(`\n\n\n${Array.from({ length: 12 }, () => "x").join("\n")}\n\n\n`)).toBeNull();
  });

  it("rejects forbidden characters", () => {
    expect(POST_CHARS_MESSAGE).toBe("Remove tabs, control characters and invisible formatting characters.");
    for (const c of [0x09, 0x07, 0x00, 0x7f, 0x85, 0x9f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff]) {
      expect(validatePostBody(`a${cp(c)}b`), `U+${c.toString(16)}`).toBe(POST_CHARS_MESSAGE);
    }
  });

  it("checks characters on the raw text (a leading tab or trailing BOM is rejected)", () => {
    expect(validatePostBody("\thello")).toBe(POST_CHARS_MESSAGE);
    expect(validatePostBody(`hello${cp(0xfeff)}`)).toBe(POST_CHARS_MESSAGE);
  });

  it("allows other non-ASCII text", () => {
    expect(validatePostBody(`caf${cp(0xe9)} ${cp(0x1f600)} ${cp(0x65e5, 0x672c)}`)).toBeNull();
  });

  it("checks lines before characters", () => {
    const lines = Array.from({ length: 13 }, () => "a\tb").join("\n");
    expect(validatePostBody(lines)).toBe(POST_LINES_MESSAGE);
  });
});

describe("paths and attach params", () => {
  it("postPath encodes the id", () => {
    expect(postPath("p1")).toBe("/p/p1");
    expect(postPath("a/b?c")).toBe("/p/a%2Fb%3Fc");
  });

  it("parseAttachParam", () => {
    expect(parseAttachParam("game:abc")).toEqual({ type: "game", id: "abc" });
    expect(parseAttachParam("collection:x")).toEqual({ type: "collection", id: "x" });
    expect(parseAttachParam("game:a:b")).toEqual({ type: "game", id: "a:b" });
    expect(parseAttachParam("foo:1")).toBeNull();
    expect(parseAttachParam("game:")).toBeNull();
    expect(parseAttachParam("game")).toBeNull();
    expect(parseAttachParam("")).toBeNull();
    expect(parseAttachParam("Game:1")).toBeNull();
    expect(parseAttachParam(null)).toBeNull();
    expect(parseAttachParam(undefined)).toBeNull();
  });

  it("postComposePath encodes the username and the id", () => {
    expect(postComposePath("mia", { type: "game", id: "g1" })).toBe("/u/mia/posts?attach=game:g1");
    expect(postComposePath("m i", { type: "collection", id: "c/1&x" })).toBe("/u/m%20i/posts?attach=collection:c%2F1%26x");
    // Round trip through the query string.
    const q = new URLSearchParams(postComposePath("mia", { type: "collection", id: "c/1&x" }).split("?")[1]);
    expect(parseAttachParam(q.get("attach"))).toEqual({ type: "collection", id: "c/1&x" });
  });

  it("postShareUrl in browser and hash mode", () => {
    expect(postShareUrl({ apiBaseUrl: "http://api.test", routerMode: "browser" }, "p1")).toBe(`${window.location.origin}/p/p1`);
    expect(postShareUrl({ apiBaseUrl: "http://api.test", routerMode: "browser", basename: "/arcade/" }, "p1")).toBe(`${window.location.origin}/arcade/p/p1`);
    expect(postShareUrl({ apiBaseUrl: "http://192.168.1.5:8080/", routerMode: "hash" }, "p1")).toBe("http://192.168.1.5:8080/p/p1");
  });
});

describe("isValidPost", () => {
  it("needs string id, body, createdAt and an author with a username", () => {
    expect(isValidPost(post("p1"))).toBe(true);
    expect(isValidPost(null)).toBe(false);
    expect(isValidPost("p1")).toBe(false);
    expect(isValidPost({ ...post("p1"), id: 1 })).toBe(false);
    expect(isValidPost({ ...post("p1"), body: null })).toBe(false);
    expect(isValidPost({ ...post("p1"), createdAt: undefined })).toBe(false);
    expect(isValidPost({ ...post("p1"), author: null })).toBe(false);
    expect(isValidPost({ ...post("p1"), author: { id: "u1" } })).toBe(false);
  });
});
