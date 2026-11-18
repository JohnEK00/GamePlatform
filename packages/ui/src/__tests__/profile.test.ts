// Kept ASCII-only: invisible / non-ASCII characters are built with String.fromCodePoint.
import { describe, expect, it } from "vitest";
import { collectionShareUrl } from "../collections";
import {
  isSafeProfileUrl,
  linkHost,
  profilePath,
  PROFILE_LINK_URL_MESSAGE,
  trimLinkLabel,
  validateProfileLinkLabel,
  validateProfileLinkUrl,
} from "../profile";
import { appShareUrl, LINK_COPIED_MS, profileShareUrl } from "../share";
import { LINK_COPIED_MS as COLLECTION_LINK_COPIED_MS } from "../pages/CollectionPage";
import { formatMonthYear } from "../util";

const ch = (cp: number) => String.fromCodePoint(cp);
const origin = window.location.origin;

describe("isSafeProfileUrl / validateProfileLinkUrl (API § F028 link rules)", () => {
  const good = [
    "https://example.com",
    "http://example.com",
    "HTTPS://Example.com/a?b#c",
    "https://www.example.com/me",
    "https://youtube.com/@mia",
    "https://x.com:8080/path",
    "https://x.com:1",
    "https://a-b.c-d.io?x=1",
    "https://x.com#frag",
    "  https://padded.example.com  ",
    `https://x.com/${"a".repeat(200 - "https://x.com/".length)}`,
  ];
  // The backend's URL cases (spec § 6) plus a few edge cases.
  const bad = [
    "javascript:alert(1)",
    "ftp://x.com",
    "https://user@x.com",
    "https://localhost",
    "https://-x.com",
    "https://x.com/ a",
    `https://ex${ch(0xe4)}mple.com`,
    "https://x.com:123456",
    "",
    `https://x.com/${"a".repeat(201 - "https://x.com/".length)}`,
    "https://x.com-",
    "https://.x.com",
    "https://x.com.",
    "https://x.com:",
    "https://x_y.com",
    "data:text/html,hi",
    "//x.com",
    "https://",
    `https://x.com${ch(0x07)}`,
  ];

  it.each(good)("accepts %j", (url) => {
    expect(isSafeProfileUrl(url)).toBe(true);
    expect(validateProfileLinkUrl(url)).toBeNull();
  });

  it.each(bad)("rejects %j", (url) => {
    expect(isSafeProfileUrl(url)).toBe(false);
    expect(validateProfileLinkUrl(url)).toBe("Enter a full link starting with https:// or http://");
  });

  it("the 201-character case is exactly one over the limit", () => {
    expect(bad[9]).toHaveLength(201);
    expect(good[good.length - 1]).toHaveLength(200);
    expect(PROFILE_LINK_URL_MESSAGE).toBe("Enter a full link starting with https:// or http://");
  });
});

describe("validateProfileLinkLabel (code-point length, forbidden characters)", () => {
  const CONTROL = "links[1].label must not contain control characters";
  const GAMEPAD = ch(0x1f3ae); // one code point, two UTF-16 units

  it("counts the 30-character limit in code points, not UTF-16 units", () => {
    const emoji30 = GAMEPAD.repeat(30);
    expect(emoji30.length).toBe(60);
    expect(validateProfileLinkLabel(emoji30, 0)).toBeNull();
    expect(validateProfileLinkLabel(GAMEPAD.repeat(31), 0)).toBe("links[0].label must be at most 30 characters");
    expect(validateProfileLinkLabel("a".repeat(30), 2)).toBeNull();
    expect(validateProfileLinkLabel("a".repeat(31), 2)).toBe("links[2].label must be at most 30 characters");
    // Measured after trim.
    expect(validateProfileLinkLabel(`  ${"a".repeat(30)}  `, 0)).toBeNull();
    expect(validateProfileLinkLabel("", 0)).toBeNull();
  });

  const forbidden: [string, number][] = [
    ["C0 NUL", 0x00],
    ["C0 BEL", 0x07],
    ["C0 US", 0x1f],
    ["DEL", 0x7f],
    ["C1 start", 0x80],
    ["C1 end", 0x9f],
    ["ZWSP", 0x200b],
    ["LRM", 0x200e],
    ["RLM", 0x200f],
    ["LRE", 0x202a],
    ["RLO", 0x202e],
    ["WJ", 0x2060],
    ["invisible plus", 0x2064],
    ["LRI", 0x2066],
    ["PDI", 0x2069],
    ["BOM", 0xfeff],
  ];
  it.each(forbidden)("rejects %s inside a label", (_name, cp) => {
    expect(validateProfileLinkLabel(`My${ch(cp)}site`, 1)).toBe(CONTROL);
  });

  it("forbidden characters are checked before the length", () => {
    expect(validateProfileLinkLabel(`${"a".repeat(40)}${ch(0x202e)}`, 1)).toBe(CONTROL);
  });

  it("checks forbidden characters on the raw label: a leading U+FEFF and a trailing U+0085 are rejected", () => {
    expect(validateProfileLinkLabel(`${ch(0xfeff)}Site${ch(0x85)}`, 1)).toBe(CONTROL);
    expect(validateProfileLinkLabel(`${ch(0xfeff)}Site`, 1)).toBe(CONTROL);
    expect(validateProfileLinkLabel(`Site${ch(0x85)}`, 1)).toBe(CONTROL);
    expect(validateProfileLinkLabel(`${ch(0x85)}Site`, 1)).toBe(CONTROL);
    // Even though both trims would strip some of these, the raw check comes first.
    expect(validateProfileLinkLabel("\tSite\n", 1)).toBe(CONTROL);
  });

  it("rejects a BOM at either end (it is not trimmed), and a tab inside", () => {
    expect(validateProfileLinkLabel(`${ch(0xfeff)}Site`, 1)).toBe(CONTROL);
    expect(validateProfileLinkLabel(`Site${ch(0xfeff)}`, 1)).toBe(CONTROL);
    expect(validateProfileLinkLabel("My\tsite", 1)).toBe(CONTROL);
  });

  it("allows neighbours of the forbidden ranges and trims surrounding White_Space", () => {
    for (const cp of [0x7e, 0xa0, 0x200a, 0x2010, 0x2029, 0x2065, 0x206a, 0xfefe, 0xe9, 0x65e5]) {
      expect(validateProfileLinkLabel(`My${ch(cp)}site`, 0)).toBeNull();
    }
    // Plain and Unicode spaces around the label are trimmed (only the length is measured after trim).
    expect(validateProfileLinkLabel(`  Site ${ch(0xa0)}${ch(0x3000)}`, 0)).toBeNull();
    expect(validateProfileLinkLabel(`${" ".repeat(10)}${"a".repeat(30)}${" ".repeat(10)}`, 0)).toBeNull();
    expect(trimLinkLabel(`${ch(0x3000)} Site ${ch(0xa0)}`)).toBe("Site");
    expect(trimLinkLabel(`${ch(0xfeff)}Site`)).toBe(`${ch(0xfeff)}Site`);
  });
});

describe("linkHost / profilePath / formatMonthYear", () => {
  it("linkHost drops a leading www.", () => {
    expect(linkHost("https://www.example.com/x")).toBe("example.com");
    expect(linkHost("https://mia.dev")).toBe("mia.dev");
    expect(linkHost("not a url")).toBe("");
  });

  it("profilePath builds the shell URLs", () => {
    expect(profilePath("Mia", "games")).toBe("/u/Mia/games");
    expect(profilePath("mia")).toBe("/u/mia");
    expect(profilePath("a b", "screenshots")).toBe("/u/a%20b/screenshots");
    expect(profilePath("mia", "collections")).toBe("/u/mia/collections");
  });

  it("formatMonthYear: month + year, '' for an invalid date", () => {
    expect(formatMonthYear("not a date")).toBe("");
    const d = new Date("2024-03-15T12:00:00Z");
    expect(formatMonthYear("2024-03-15T12:00:00Z")).toBe(d.toLocaleDateString(undefined, { year: "numeric", month: "long" }));
    expect(formatMonthYear("2024-03-15T12:00:00Z")).toContain("2024");
  });
});

describe("share links (share.ts)", () => {
  it("browser mode: page origin plus basename", () => {
    expect(appShareUrl({ apiBaseUrl: "http://api.test", routerMode: "browser" }, "/u/mia")).toBe(`${origin}/u/mia`);
    expect(appShareUrl({ apiBaseUrl: "", routerMode: "browser", basename: "/arcade/" }, "/u/mia")).toBe(`${origin}/arcade/u/mia`);
    expect(profileShareUrl({ apiBaseUrl: "", routerMode: "browser", basename: "/arcade" }, "mia")).toBe(`${origin}/arcade/u/mia`);
    expect(profileShareUrl({ apiBaseUrl: "", routerMode: "browser" }, "a b")).toBe(`${origin}/u/a%20b`);
  });

  it("hash mode: the configured server with trailing slashes trimmed (never a #/ URL)", () => {
    expect(profileShareUrl({ apiBaseUrl: "http://192.168.1.5:8080///", routerMode: "hash" }, "mia")).toBe("http://192.168.1.5:8080/u/mia");
    expect(appShareUrl({ apiBaseUrl: " http://srv/ ", routerMode: "hash" }, "/c/x")).toBe("http://srv/c/x");
    expect(profileShareUrl({ apiBaseUrl: "", routerMode: "hash" }, "mia")).toBe(`${origin}/u/mia`);
  });

  it("collectionShareUrl output is unchanged", () => {
    expect(collectionShareUrl({ apiBaseUrl: "http://api.test", routerMode: "browser" }, "c1")).toBe(`${origin}/c/c1`);
    expect(collectionShareUrl({ apiBaseUrl: "", routerMode: "browser", basename: "/arcade/" }, "c 1")).toBe(`${origin}/arcade/c/c%201`);
    expect(collectionShareUrl({ apiBaseUrl: "", routerMode: "browser", basename: "relative" }, "c1")).toBe(`${origin}/c/c1`);
    expect(collectionShareUrl({ apiBaseUrl: "http://srv:8080//", routerMode: "hash" }, "c1")).toBe("http://srv:8080/c/c1");
    expect(collectionShareUrl({ apiBaseUrl: "", routerMode: "hash" }, "c1")).toBe(`${origin}/c/c1`);
  });

  it("LINK_COPIED_MS is 2000 and still re-exported from CollectionPage", () => {
    expect(LINK_COPIED_MS).toBe(2000);
    expect(COLLECTION_LINK_COPIED_MS).toBe(LINK_COPIED_MS);
  });
});
