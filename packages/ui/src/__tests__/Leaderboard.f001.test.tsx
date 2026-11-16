import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Leaderboard as LeaderboardData, LeaderboardConfig, LeaderboardPeriod, Score } from "../api/types";
import { Leaderboard, LEADERBOARD_PERIOD_KEY } from "../components/Leaderboard";
import { WebGameProviders } from "../WebGameApp";

const user = (n: number) => ({ id: `u${n}`, username: `user${n}`, displayName: `User ${n}`, avatarUrl: null });
const score = (n: number, value: number, rank: number): Score => ({ id: `s${n}`, user: user(n), score: value, createdAt: "2026-11-14T00:00:00.000Z", rank });
const timeCfg: LeaderboardConfig = { order: "asc", format: "time", label: "Best time" };

function board(period: LeaderboardPeriod, over: Partial<LeaderboardData> = {}): LeaderboardData {
  return {
    period,
    periodStart: period === "all" ? null : "2026-11-09T00:00:00.000Z",
    periodEnd: period === "all" ? null : new Date(Date.now() + (5 * 60 + 12) * 60_000 + 30_000).toISOString(),
    config: timeCfg,
    entries: [score(1, 83_456, 1), score(2, 90_000, 2)],
    totalPlayers: 41,
    me: score(9, 125_000, 41),
    ...over,
  };
}

function setup(impl: (period: LeaderboardPeriod) => LeaderboardData) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const get = vi.spyOn(client, "getLeaderboard").mockImplementation(async (_id, q) => impl(q?.period ?? "all"));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <Leaderboard gameId="g1" config={timeCfg} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { ...utils, get };
}

afterEach(() => vi.restoreAllMocks());

describe("Leaderboard (F001)", () => {
  it("defaults to This week, formats times, shows the label and the footer", async () => {
    const { get } = setup((p) => board(p));
    expect(await screen.findByText("1:23.456")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("g1", { period: "week", limit: 10 });
    expect(screen.getByRole("tab", { name: "This week" }).getAttribute("aria-selected")).toBe("true");
    // N6: scores live in a tabpanel labelled by / controlled from the selected tab.
    const panel = screen.getByRole("tabpanel", { name: "This week" });
    expect(screen.getByRole("tab", { name: "This week" }).getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toContain("1:23.456");
    expect(screen.getAllByText("Best time").length).toBeGreaterThan(0);
    expect(screen.getByText("41 players · resets in 5h 12m")).toBeTruthy();
  });

  it("shows the viewer's row below a divider when outside the top", async () => {
    const { container } = setup((p) => board(p));
    expect(await screen.findByText("User 9")).toBeTruthy();
    expect(container.querySelector(".pf-lb__divider")).toBeTruthy();
    const meRow = container.querySelector(".pf-lb__me li.is-me");
    expect(meRow?.textContent).toContain("2:05.000");
    expect(meRow?.textContent).toContain("41");
  });

  it("does not duplicate the viewer's row when it is in the top", async () => {
    const { container } = setup((p) => board(p, { me: score(2, 90_000, 2) }));
    await screen.findByText("User 2");
    expect(container.querySelector(".pf-lb__divider")).toBeNull();
    expect(container.querySelectorAll("li.is-me").length).toBe(1);
  });

  it("switches tabs, remembers the choice and shows per-period empty states", async () => {
    const { get } = setup((p) => (p === "day" ? board(p, { entries: [], me: null, totalPlayers: 0 }) : board(p)));
    await screen.findByText("1:23.456");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Today" }));
    });
    expect(await screen.findByText("No scores today yet — be the first!")).toBeTruthy();
    expect(get).toHaveBeenLastCalledWith("g1", { period: "day", limit: 10 });
    expect(localStorage.getItem(LEADERBOARD_PERIOD_KEY)).toBe("day");

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "All time" }));
    });
    await waitFor(() => expect(screen.getByText("41 players")).toBeTruthy());
  });

  it("supports arrow-key navigation between periods (N6)", async () => {
    const { get } = setup((p) => board(p));
    await screen.findByText("1:23.456");
    const week = screen.getByRole("tab", { name: "This week" });
    await act(async () => {
      week.focus();
      fireEvent.keyDown(week, { key: "ArrowLeft" });
    });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Today" }));
    expect(get).toHaveBeenLastCalledWith("g1", { period: "day", limit: 10 });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("tab", { name: "Today" }), { key: "End" });
    });
    expect(screen.getByRole("tab", { name: "All time" }).getAttribute("aria-selected")).toBe("true");
  });

  it("starts on the remembered period", async () => {
    localStorage.setItem(LEADERBOARD_PERIOD_KEY, "all");
    const { get } = setup((p) => board(p));
    await screen.findByText("1:23.456");
    expect(get).toHaveBeenCalledWith("g1", { period: "all", limit: 10 });
  });
});
