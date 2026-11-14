import { describe, expect, it } from "vitest";
import { formatScore, formatTimeUntil } from "../util";

describe("formatScore", () => {
  it("formats numbers with the locale", () => {
    expect(formatScore(1234567, "number")).toBe((1234567).toLocaleString());
    expect(formatScore(0, "number")).toBe("0");
  });

  it("formats times as m:ss.mmm", () => {
    expect(formatScore(0, "time")).toBe("0:00.000");
    expect(formatScore(83_456, "time")).toBe("1:23.456");
    expect(formatScore(5_007, "time")).toBe("0:05.007");
    expect(formatScore(3_599_999, "time")).toBe("59:59.999");
  });

  it("uses h:mm:ss.mmm from one hour", () => {
    expect(formatScore(3_600_000, "time")).toBe("1:00:00.000");
    expect(formatScore(86_400_000, "time")).toBe("24:00:00.000");
    expect(formatScore(3_723_004, "time")).toBe("1:02:03.004");
  });

  it("returns an em dash for negative or non-finite values", () => {
    expect(formatScore(-1, "time")).toBe("—");
    expect(formatScore(Number.NaN, "time")).toBe("—");
    expect(formatScore(Number.POSITIVE_INFINITY, "number")).toBe("—");
    expect(formatScore(Number.NaN, "number")).toBe("—");
  });
});

describe("formatTimeUntil", () => {
  const now = Date.parse("2026-11-14T18:48:00.000Z");
  it("formats the remaining time", () => {
    expect(formatTimeUntil("2026-11-15T00:00:00.000Z", now)).toBe("5h 12m");
    expect(formatTimeUntil("2026-11-14T19:00:00.000Z", now)).toBe("12m");
    expect(formatTimeUntil("2026-11-16T00:00:00.000Z", now)).toBe("1d 5h");
    expect(formatTimeUntil(null, now)).toBeNull();
    expect(formatTimeUntil("2026-11-14T00:00:00.000Z", now)).toBeNull();
  });
});
