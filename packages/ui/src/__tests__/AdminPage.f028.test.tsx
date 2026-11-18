import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Report } from "../api/types";
import { AdminPage, reportActions } from "../pages/AdminPage";
import { WebGameProviders } from "../WebGameApp";
import { adminUser, sam } from "./collectionFixtures";

const report = (over: Partial<Report> = {}): Report => ({
  id: "r1",
  targetType: "user",
  targetId: "u7",
  targetPreview: "@mia",
  targetGameId: null,
  reason: "offensive",
  details: "",
  reporter: sam,
  status: "open",
  resolution: null,
  createdAt: "2026-11-15T10:00:00Z",
  resolvedAt: null,
  targetImageUrl: null,
  targetImageFullUrl: null,
  ...over,
});

async function setup(reports: Report[]) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(adminUser);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "listReports").mockResolvedValue({ items: reports, total: reports.length, page: 1, perPage: 25 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.listReports).toHaveBeenCalled());
  await act(async () => {});
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe("AdminPage profile reports (F028)", () => {
  it("reportActions('user') is Dismiss + Clear profile", () => {
    expect(reportActions("user")).toEqual(["dismiss", "clearProfile"]);
    expect(reportActions("game")).toEqual(["dismiss", "unpublish", "delete"]);
    expect(reportActions("collection")).toEqual(["dismiss", "delete"]);
  });

  it("a user row shows the badge, @mia and View profile → /u/mia", async () => {
    await setup([report()]);
    const row = screen.getByText("@mia").closest("li")!;
    expect(within(row).getByText("user").className).toContain("pf-badge--user");
    expect(within(row).getByText("@mia").tagName).toBe("STRONG");
    expect(within(row).getByRole("link", { name: "View profile →" }).getAttribute("href")).toBe("/u/mia");
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Dismiss", "Clear profile"]);
  });

  it("Clear profile confirms with the exact copy (danger) and sends clearProfile", async () => {
    const client = await setup([report(), report({ id: "r2", reporter: adminUser })]);
    const resolve = vi.spyOn(client, "resolveReport").mockResolvedValue(report({ status: "resolved", resolution: "clearProfile" }));
    const row = screen.getAllByText("@mia")[0].closest("li")!;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Clear profile" })));
    const dialog = screen.getByRole("dialog", { name: "Clear @mia's profile?" });
    expect(
      within(dialog).getByText("Their display name, bio, links, avatar and banner are reset. Their games, comments and other content stay up."),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Clear profile" });
    expect(confirm.className).toContain("pf-btn--danger");
    await act(async () => fireEvent.click(confirm));
    expect(resolve).toHaveBeenCalledWith("r1", "clearProfile");
    // Every open report on the same user is resolved together.
    expect(screen.queryByText("@mia", { selector: "strong" })).toBeNull();
  });
});
