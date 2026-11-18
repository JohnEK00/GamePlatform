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
  targetType: "post",
  targetId: "p1",
  targetPreview: "Buy cheap gold at\nscam.example",
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
  const fetchMock = async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
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

describe("AdminPage post reports (F030 section 0.17)", () => {
  it("reportActions('post') is Dismiss + Delete", () => {
    expect(reportActions("post")).toEqual(["dismiss", "delete"]);
  });

  it("a post row shows the badge, the quote, View post → /p/{id}, Dismiss and Delete", async () => {
    await setup([report()]);
    const row = document.querySelector<HTMLElement>(".pf-report-row")!;
    expect(within(row).getByText("post").className).toContain("pf-badge--post");
    const quote = row.querySelector("blockquote.pf-report-row__quote")!;
    expect(quote.textContent).toBe("Buy cheap gold at\nscam.example");
    const view = within(row).getByRole("link", { name: "View post →" });
    expect(view.getAttribute("href")).toBe("/p/p1");
    expect(view.className).toBe("pf-small");
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Dismiss", "Delete"]);
  });

  it("Delete confirms with the post copy and sends delete", async () => {
    const client = await setup([report()]);
    const resolve = vi.spyOn(client, "resolveReport").mockResolvedValue(report({ status: "resolved", resolution: "delete" }));
    const row = document.querySelector<HTMLElement>(".pf-report-row")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this post?" });
    expect(within(dialog).getByText("The post is removed permanently.")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
    expect(resolve).toHaveBeenCalledWith("r1", "delete");
  });

  it("the link encodes the post id", async () => {
    await setup([report({ targetId: "a/b" })]);
    expect(screen.getByRole("link", { name: "View post →" }).getAttribute("href")).toBe("/p/a%2Fb");
  });
});
