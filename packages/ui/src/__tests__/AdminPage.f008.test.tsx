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
  targetType: "collection",
  targetId: "c1",
  targetPreview: "Totally legit free games",
  targetGameId: null,
  reason: "spam",
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

describe("AdminPage collection reports (F008)", () => {
  it("shows the badge, the preview as text, View collection and Dismiss / Delete only", async () => {
    const client = await setup([report()]);
    const row = screen.getByText("Totally legit free games").closest("li")!;
    expect(within(row).getByText("collection").className).toContain("pf-badge--collection");
    expect(within(row).getByText("Totally legit free games").tagName).toBe("STRONG");
    expect(within(row).getByRole("link", { name: "View collection →" }).getAttribute("href")).toBe("/c/c1");
    expect(within(row).queryByRole("link", { name: /game/i })).toBeNull();
    const buttons = within(row)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Dismiss", "Delete"]);

    const resolve = vi.spyOn(client, "resolveReport").mockResolvedValue(report({ status: "resolved", resolution: "delete" }));
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Delete" })));
    const dialog = screen.getByRole("dialog", { name: "Delete this collection?" });
    expect(within(dialog).getByText("The games stay on the site; only this list is removed.")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
    expect(resolve).toHaveBeenCalledWith("r1", "delete");
    expect(screen.queryByText("Totally legit free games", { selector: "strong" })).toBeNull();
  });

  it("an unknown target type gets Dismiss only", async () => {
    await setup([report({ id: "r2", targetType: "playlist" as Report["targetType"], targetPreview: "Future thing" })]);
    const row = screen.getByText("Future thing").closest("li")!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Dismiss"]);
    expect(reportActions("game")).toEqual(["dismiss", "unpublish", "delete"]);
    expect(reportActions("comment")).toEqual(["dismiss", "delete"]);
  });
});
