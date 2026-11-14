import { describe, expect, it } from "vitest";
import { clampNotesEdit } from "../components/ReleaseNotesField";

describe("clampNotesEdit (N8)", () => {
  it("passes edits within the limit through untouched", () => {
    expect(clampNotesEdit("ab", "abc", 3)).toEqual({ value: "abc", caret: null });
    expect(clampNotesEdit("😀😀", "😀😀😀", 3)).toEqual({ value: "😀😀😀", caret: null });
  });

  it("counts code points, not UTF-16 units", () => {
    // 3 emoji = 6 UTF-16 units, still within 3 code points.
    expect(clampNotesEdit("", "😀😀😀", 3).value).toBe("😀😀😀");
    expect(clampNotesEdit("", "😀😀😀😀", 3).value).toBe("😀😀😀");
  });

  it("cuts only the inserted run, keeping text after the caret", () => {
    // Paste "XYZ" in the middle of "abcd" with a limit of 6.
    const r = clampNotesEdit("abcd", "abXYZcd", 6);
    expect(r).toEqual({ value: "abXYcd", caret: 4 });
  });

  it("never splits a surrogate pair and places the caret in UTF-16 units", () => {
    const r = clampNotesEdit("a", "a😀😀", 2);
    expect(r).toEqual({ value: "a😀", caret: 3 });
  });

  it("always accepts deletions, even over the limit", () => {
    expect(clampNotesEdit("abcdef", "abcde", 3).value).toBe("abcde");
  });

  it("rejects insertions when already full", () => {
    expect(clampNotesEdit("abc", "abxc", 3)).toEqual({ value: "abc", caret: 2 });
  });
});
