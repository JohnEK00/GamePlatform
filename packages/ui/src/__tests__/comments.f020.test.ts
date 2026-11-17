import { describe, expect, it } from "vitest";
import {
  COMMENT_MODES,
  SLOW_MODE_SECS,
  formatWait,
  isF020CommentPage,
  normalizeCommentListPage,
  normalizeCommentSettings,
  normalizeCommentSettingsView,
  slowModeInterval,
  slowModeShort,
} from "../api/comments";

const DEFAULTS = { mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0 };

describe("normalizeCommentSettingsView (F020)", () => {
  it("missing or not an object → the defaults", () => {
    expect(normalizeCommentSettingsView(undefined)).toEqual(DEFAULTS);
    expect(normalizeCommentSettingsView(null)).toEqual(DEFAULTS);
    expect(normalizeCommentSettingsView("on")).toEqual(DEFAULTS);
    expect(normalizeCommentSettingsView({})).toEqual(DEFAULTS);
  });

  it("keeps valid values", () => {
    expect(normalizeCommentSettingsView({ mode: "repliesOnly", slowModeSecs: 300, canManage: true, waitSecs: 12 })).toEqual({
      mode: "repliesOnly",
      slowModeSecs: 300,
      canManage: true,
      waitSecs: 12,
    });
    for (const mode of ["on", "repliesOnly", "off"]) expect(normalizeCommentSettingsView({ mode }).mode).toBe(mode);
    for (const s of [0, 30, 60, 300, 900, 3600]) expect(normalizeCommentSettingsView({ slowModeSecs: s }).slowModeSecs).toBe(s);
  });

  it("an unknown mode reads as on, an unknown interval as 0", () => {
    expect(normalizeCommentSettingsView({ mode: "closed" }).mode).toBe("on");
    expect(normalizeCommentSettingsView({ mode: "OFF" }).mode).toBe("on");
    expect(normalizeCommentSettingsView({ mode: 1 }).mode).toBe("on");
    for (const s of [45, -1, 60.5, "60", null, true, Number.NaN, 7200]) {
      expect(normalizeCommentSettingsView({ slowModeSecs: s }).slowModeSecs).toBe(0);
    }
  });

  it("canManage only when exactly true", () => {
    expect(normalizeCommentSettingsView({ canManage: "true" }).canManage).toBe(false);
    expect(normalizeCommentSettingsView({ canManage: 1 }).canManage).toBe(false);
  });

  it("waitSecs: non-finite or negative → 0, else rounded up", () => {
    expect(normalizeCommentSettingsView({ waitSecs: -5 }).waitSecs).toBe(0);
    expect(normalizeCommentSettingsView({ waitSecs: Number.POSITIVE_INFINITY }).waitSecs).toBe(0);
    expect(normalizeCommentSettingsView({ waitSecs: Number.NaN }).waitSecs).toBe(0);
    expect(normalizeCommentSettingsView({ waitSecs: "10" }).waitSecs).toBe(0);
    expect(normalizeCommentSettingsView({ waitSecs: 0 }).waitSecs).toBe(0);
    expect(normalizeCommentSettingsView({ waitSecs: 0.2 }).waitSecs).toBe(1);
    expect(normalizeCommentSettingsView({ waitSecs: 58.01 }).waitSecs).toBe(59);
    expect(normalizeCommentSettingsView({ waitSecs: 60 }).waitSecs).toBe(60);
  });

  it("normalizeCommentSettings drops the view fields", () => {
    expect(normalizeCommentSettings({ mode: "off", slowModeSecs: 60, canManage: true, waitSecs: 3 })).toEqual({ mode: "off", slowModeSecs: 60 });
    expect(normalizeCommentSettings(undefined)).toEqual({ mode: "on", slowModeSecs: 0 });
  });

  it("the list page carries normalised settings; isF020CommentPage checks the key", () => {
    const base = { items: [], total: 0, totalAll: 0, page: 1, perPage: 20, pinned: null };
    expect(normalizeCommentListPage(base).settings).toEqual(DEFAULTS);
    expect(normalizeCommentListPage({ ...base, settings: { mode: "off", slowModeSecs: 60, canManage: false, waitSecs: 5 } }).settings).toEqual({
      mode: "off",
      slowModeSecs: 60,
      canManage: false,
      waitSecs: 5,
    });
    expect(isF020CommentPage(base)).toBe(false);
    expect(isF020CommentPage({ ...base, settings: null })).toBe(true);
    expect(isF020CommentPage(null)).toBe(false);
  });

  it("modes and intervals are in the form's order", () => {
    expect(COMMENT_MODES).toEqual(["on", "repliesOnly", "off"]);
    expect(SLOW_MODE_SECS).toEqual([0, 30, 60, 300, 900, 3600]);
  });
});

describe("slow-mode texts (F020 § 2.3, § 2.5)", () => {
  it("slowModeInterval", () => {
    expect(slowModeInterval(30)).toBe("30 seconds");
    expect(slowModeInterval(60)).toBe("minute");
    expect(slowModeInterval(300)).toBe("5 minutes");
    expect(slowModeInterval(900)).toBe("15 minutes");
    expect(slowModeInterval(3600)).toBe("hour");
    expect(slowModeInterval(0)).toBe("");
  });

  it("slowModeShort", () => {
    expect(slowModeShort(30)).toBe("30 s");
    expect(slowModeShort(60)).toBe("1 min");
    expect(slowModeShort(300)).toBe("5 min");
    expect(slowModeShort(900)).toBe("15 min");
    expect(slowModeShort(3600)).toBe("1 h");
    expect(slowModeShort(0)).toBe("");
  });

  it("formatWait is m:ss", () => {
    expect(formatWait(5)).toBe("0:05");
    expect(formatWait(298)).toBe("4:58");
    expect(formatWait(3600)).toBe("60:00");
    expect(formatWait(60)).toBe("1:00");
    expect(formatWait(59)).toBe("0:59");
    expect(formatWait(0)).toBe("0:00");
    expect(formatWait(-3)).toBe("0:00");
    expect(formatWait(4.2)).toBe("0:05");
  });
});
