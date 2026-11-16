import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_NOTE_MAX,
  COLLECTION_TITLE_MAX,
  collectionMessage,
  collectionPath,
  collectionShareUrl,
  gamesLabel,
  moveItem,
  normalizeCollectionDescription,
  validateCollectionDescription,
  validateCollectionNote,
  validateCollectionTitle,
} from "../collections";
import { isCollectionsUnsupportedError } from "../components/collectionsSupport";

afterEach(() => vi.unstubAllGlobals());

describe("validateCollectionTitle", () => {
  it("accepts 1–60 code points after trimming", () => {
    expect(validateCollectionTitle("Cozy games")).toBeNull();
    expect(validateCollectionTitle("  x  ")).toBeNull();
    expect(validateCollectionTitle("a".repeat(COLLECTION_TITLE_MAX))).toBeNull();
    // 60 astral characters are 120 UTF-16 units but 60 code points.
    expect(validateCollectionTitle("🎮".repeat(60))).toBeNull();
  });
  it("rejects empty, too long, multi-line and bidi titles", () => {
    expect(validateCollectionTitle("")).toBe("title must be 1–60 characters");
    expect(validateCollectionTitle("   ")).toBe("title must be 1–60 characters");
    expect(validateCollectionTitle("a".repeat(61))).toBe("title must be 1–60 characters");
    expect(validateCollectionTitle("🎮".repeat(61))).toBe("title must be 1–60 characters");
    expect(validateCollectionTitle("a\nb")).toBe("title must be a single line of plain text");
    expect(validateCollectionTitle("a\tb")).toBe("title must be a single line of plain text");
    expect(validateCollectionTitle("a\u0085b")).toBe("title must be a single line of plain text");
    expect(validateCollectionTitle("evil‮gnp.exe")).toBe("title must be a single line of plain text");
    expect(validateCollectionTitle("x⁦y")).toBe("title must be a single line of plain text");
  });
});

describe("validateCollectionDescription", () => {
  it("accepts up to 500 code points and 8 lines; normalises CRLF", () => {
    expect(validateCollectionDescription("")).toBeNull();
    expect(validateCollectionDescription("a".repeat(COLLECTION_DESCRIPTION_MAX))).toBeNull();
    expect(validateCollectionDescription(Array(8).fill("line").join("\n"))).toBeNull();
    expect(validateCollectionDescription(Array(8).fill("line").join("\r\n"))).toBeNull();
    expect(normalizeCollectionDescription("  a\r\nb\rc  ")).toBe("a\nb\nc");
  });
  it("rejects too long, too many lines, other controls and bidi", () => {
    expect(validateCollectionDescription("a".repeat(501))).toBe("description must be at most 500 characters");
    expect(validateCollectionDescription(Array(9).fill("l").join("\n"))).toBe("description must be at most 8 lines");
    expect(validateCollectionDescription(Array(9).fill("l").join("\r"))).toBe("description must be at most 8 lines");
    expect(validateCollectionDescription("a\tb")).toBe("description must be plain text");
    expect(validateCollectionDescription("a\u0000b")).toBe("description must be plain text");
    expect(validateCollectionDescription("a‪b")).toBe("description must be plain text");
  });
});

describe("validateCollectionNote", () => {
  it("accepts 0–140 code points", () => {
    expect(validateCollectionNote("")).toBeNull();
    expect(validateCollectionNote("a".repeat(COLLECTION_NOTE_MAX))).toBeNull();
    expect(validateCollectionNote("é".repeat(140))).toBeNull();
  });
  it("rejects too long, newline and bidi", () => {
    expect(validateCollectionNote("a".repeat(141))).toBe("note must be at most 140 characters");
    expect(validateCollectionNote("a\nb")).toBe("note must be a single line of plain text");
    expect(validateCollectionNote("a⁩")).toBe("note must be a single line of plain text");
  });
  it("collectionMessage capitalises and ends with a period", () => {
    expect(collectionMessage("note must be at most 140 characters")).toBe("Note must be at most 140 characters.");
    expect(collectionMessage("Done.")).toBe("Done.");
  });
});

describe("moveItem", () => {
  it("moves up, down, to the ends, and returns a copy", () => {
    const ids = ["a", "b", "c", "d"];
    expect(moveItem(ids, 2, 1)).toEqual(["a", "c", "b", "d"]);
    expect(moveItem(ids, 0, 1)).toEqual(["b", "a", "c", "d"]);
    expect(moveItem(ids, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(ids, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(moveItem(ids, 1, 1)).not.toBe(ids);
  });
  it("clamps the target and ignores an invalid source", () => {
    expect(moveItem(["a", "b"], 0, 9)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 1, -4)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
});

describe("collectionShareUrl", () => {
  it("browser mode: the page origin", () => {
    expect(collectionShareUrl({ apiBaseUrl: "http://api.test", routerMode: "browser" }, "c1")).toBe(`${window.location.origin}/c/c1`);
    expect(collectionShareUrl({ apiBaseUrl: "", routerMode: "browser", basename: "/arcade/" }, "c1")).toBe(`${window.location.origin}/arcade/c/c1`);
  });
  it("hash mode (desktop): the configured server, never a #/ or tauri:// URL", () => {
    const url = collectionShareUrl({ apiBaseUrl: "https://games.example.com/", routerMode: "hash" }, "c1");
    expect(url).toBe("https://games.example.com/c/c1");
    expect(url).not.toContain("#");
  });
  it("hash mode with an empty apiBaseUrl falls back to the page origin", () => {
    expect(collectionShareUrl({ apiBaseUrl: "", routerMode: "hash" }, "c 1")).toBe(`${window.location.origin}/c/c%201`);
    expect(collectionShareUrl({ apiBaseUrl: "  ", routerMode: "hash" }, "c1")).toBe(`${window.location.origin}/c/c1`);
  });
  it("collectionPath trusts only /c/{id} paths; gamesLabel pluralises", () => {
    expect(collectionPath({ id: "c1", path: "/c/c1" })).toBe("/c/c1");
    expect(collectionPath({ id: "c1", path: "//evil.example/x" })).toBe("/c/c1");
    expect(collectionPath({ id: "c/1" })).toBe("/c/c%2F1");
    expect(gamesLabel(1)).toBe("1 game");
    expect(gamesLabel(0)).toBe("0 games");
  });
});

describe("isCollectionsUnsupportedError", () => {
  it("tells a missing endpoint from a real not-found", () => {
    expect(isCollectionsUnsupportedError(new ApiError("not_found", "No such API endpoint", 404))).toBe(true);
    expect(isCollectionsUnsupportedError(new ApiError("not_found", "Not Found", 404))).toBe(true);
    expect(isCollectionsUnsupportedError(new ApiError("unknown", "Method Not Allowed", 405))).toBe(true);
    expect(isCollectionsUnsupportedError(new ApiError("not_found", "Collection not found", 404))).toBe(false);
    expect(isCollectionsUnsupportedError(new ApiError("not_found", "User not found", 404))).toBe(false);
    expect(isCollectionsUnsupportedError(new ApiError("internal", "boom", 500))).toBe(false);
    expect(isCollectionsUnsupportedError(new Error("x"))).toBe(false);
  });
});
