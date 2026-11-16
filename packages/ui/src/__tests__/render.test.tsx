import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary } from "../api/types";
import { GameCard } from "../components/GameCard";
import { WebGameApp, WebGameProviders } from "../WebGameApp";

const summary: GameSummary = {
  id: "g1",
  title: "Space Dodge",
  description: "Dodge the rocks",
  tags: ["arcade"],
  owner: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
  thumbnailUrl: "/media/thumbnails/g1.png?v=1",
  plays: 1500,
  ratingAvg: 4.5,
  ratingCount: 10,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
};

describe("render", () => {
  it("GameCard shows title, owner, plays and resolves the thumbnail URL", () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const { container } = render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <GameCard game={summary} />
        </MemoryRouter>
      </WebGameProviders>,
    );
    expect(screen.getByText("Space Dodge")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText(/1\.5k/)).toBeTruthy();
    expect(container.querySelector("img")!.getAttribute("src")).toBe("http://api.test/media/thumbnails/g1.png?v=1");
  });

  it("WebGameApp renders the home page with games from the API", async () => {
    const client = new ApiClient({ baseUrl: "" });
    vi.spyOn(client, "listTags").mockResolvedValue([{ tag: "arcade", count: 3 }]);
    vi.spyOn(client, "listGames").mockResolvedValue({ items: [summary], total: 1, page: 1, perPage: 24 });
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={client} />);
    expect(screen.getAllByText(/Pixelforge/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText("Space Dodge").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "#arcade" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Log in" })).toBeTruthy();
  });

  it("shows the 404 page for unknown routes", () => {
    window.location.hash = "#/definitely/not/here";
    const client = new ApiClient({ baseUrl: "" });
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={client} />);
    expect(screen.getByText(/page not found/)).toBeTruthy();
    window.location.hash = "";
  });
});
