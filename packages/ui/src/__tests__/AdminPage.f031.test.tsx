import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Report } from "../api/types";
import { AdminPage, reportActions } from "../pages/AdminPage";
import { WebGameProviders } from "../WebGameApp";
import { adminUser, sam } from "./collectionFixtures";

const report = (over: Partial<Report> = {}): Report => ({
  id: "rep1",
  targetType: "postReply",
  targetId: "r1",
  targetPreview: "You are all idiots",
  targetGameId: null,
  targetPostId: "p1",
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

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AdminPage post reply reports (F031 § 0.17)", () => {
  it("reportActions('postReply') is Dismiss + Delete", () => {
    expect(reportActions("postReply")).toEqual(["dismiss", "delete"]);
  });

  it("a postReply row shows the badge, the quote, View in context → the reply permalink, Dismiss and Delete", async () => {
    await setup([report()]);
    const row = document.querySelector<HTMLElement>(".pf-report-row")!;
    expect(within(row).getByText("postReply").className).toContain("pf-badge--postReply");
    expect(row.querySelector("blockquote.pf-report-row__quote")!.textContent).toBe("You are all idiots");
    const view = within(row).getByRole("link", { name: "View in context →" });
    expect(view.getAttribute("href")).toBe("/p/p1?reply=r1");
    expect(view.className).toBe("pf-small");
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Dismiss", "Delete"]);
  });

  it("no link when targetPostId is null or missing; ids are encoded", async () => {
    const { targetPostId: _omit, ...noField } = report({ id: "rep3" });
    void _omit;
    await setup([report({ targetPostId: null }), noField as Report, report({ id: "rep4", targetPostId: "a/b", targetId: "c d" })]);
    const rows = document.querySelectorAll<HTMLElement>(".pf-report-row");
    expect(within(rows[0]).queryByRole("link", { name: "View in context →" })).toBeNull();
    expect(within(rows[1]).queryByRole("link", { name: "View in context →" })).toBeNull();
    expect(within(rows[2]).getByRole("link", { name: "View in context →" }).getAttribute("href")).toBe("/p/a%2Fb?reply=c%20d");
  });

  it("Delete confirms with the reply copy and sends delete", async () => {
    const client = await setup([report()]);
    const resolve = vi.spyOn(client, "resolveReport").mockResolvedValue(report({ status: "resolved", resolution: "delete" }));
    const row = document.querySelector<HTMLElement>(".pf-report-row")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this reply?" });
    expect(within(dialog).getByText("The reply is removed permanently.")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
    expect(resolve).toHaveBeenCalledWith("rep1", "delete");
  });

  it("the F030 post row's View post → link is unchanged", async () => {
    await setup([report({ targetType: "post", targetId: "p1", targetPostId: "p1" })]);
    expect(screen.getByRole("link", { name: "View post →" }).getAttribute("href")).toBe("/p/p1");
    expect(screen.queryByRole("link", { name: "View in context →" })).toBeNull();
  });
});
