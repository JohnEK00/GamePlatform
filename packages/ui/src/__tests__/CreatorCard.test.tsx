import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorCard, CreatorCardSkeleton } from "../components/CreatorCard";
import { creator, mia, viewer } from "./creatorFixtures";
import { currentLocation, makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const miaCard = (over: Parameters<typeof creator>[1] = {}) => creator("mia", { user: mia, ...over });

describe("CreatorCard (F035)", () => {
  it("is an article named by the creator, with the name and avatar links", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <CreatorCard creator={miaCard()} />);
    const article = screen.getByRole("article", { name: "Mia" });
    expect(article.className).toContain("pf-creator-card");
    expect(article.getAttribute("aria-labelledby")).toBe("creator-u2-name");
    const heading = screen.getByRole("heading", { level: 2, name: "Mia" });
    expect(heading.id).toBe("creator-u2-name");
    expect(screen.getByRole("link", { name: "Mia" }).getAttribute("href")).toBe("/u/mia");
    const avatar = container.querySelector(".pf-creator-card__avatar")!;
    expect(avatar.tagName).toBe("A");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.getAttribute("tabindex")).toBe("-1");
    expect(avatar.getAttribute("href")).toBe("/u/mia");
    expect(screen.getByText("@mia")).toBeTruthy();
  });

  it("falls back to the username when there is no display name", async () => {
    const client = makeClient(null);
    await renderWith(client, <CreatorCard creator={miaCard({ user: { ...mia, displayName: "" } })} />);
    expect(screen.getByRole("article", { name: "mia" })).toBeTruthy();
  });

  it("renders the banner as a decorative image resolved against the API base", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <CreatorCard creator={miaCard({ bannerUrl: "/media/banners/u2.jpg?v=2" })} />);
    const img = container.querySelector(".pf-creator-card__banner img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe("http://api.test/media/banners/u2.jpg?v=2");
    expect(container.querySelector(".pf-creator-card__banner")!.className).toContain("has-image");
  });

  it("uses the empty-banner gradient without a banner", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <CreatorCard creator={miaCard()} />);
    const banner = container.querySelector(".pf-creator-card__banner")!;
    expect(banner.className).toContain("pf-profile__banner");
    expect(banner.className).not.toContain("has-image");
    expect(banner.querySelector("img")).toBeNull();
  });

  it("shows the bio only when present (as text, never HTML)", async () => {
    const client = makeClient(null);
    const { container, unmount } = await renderWith(client, <CreatorCard creator={miaCard({ bioExcerpt: "Makes <b>tiny</b> games\nfor fun" })} />);
    const bio = container.querySelector(".pf-creator-card__bio")!;
    expect(bio.textContent).toBe("Makes <b>tiny</b> games\nfor fun");
    expect(bio.querySelector("b")).toBeNull();
    unmount();
    const r2 = await renderWith(client, <CreatorCard creator={miaCard({ bioExcerpt: "" })} />);
    expect(r2.container.querySelector(".pf-creator-card__bio")).toBeNull();
  });

  it("shows the stats line", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <CreatorCard creator={miaCard({ games: 3, plays: 1200, followers: 45 })} />);
    expect(container.querySelector(".pf-creator-card__stats")!.textContent).toBe("3 games · 1.2k plays · 45 followers");
  });

  it("anonymous: Follow Mia sends to login", async () => {
    const client = makeClient(null);
    await renderWith(client, <CreatorCard creator={miaCard()} />, "/creators");
    const btn = screen.getByRole("button", { name: "Follow Mia" });
    fireEvent.click(btn);
    expect(currentLocation()).toBe("/login?next=%2Fcreators");
  });

  it("signed in: Follow Mia, and the stats follow the store after a follow", async () => {
    const client = makeClient(viewer);
    const follow = vi.spyOn(client, "setFollowing").mockResolvedValue({ following: true, followers: 6 });
    const { container } = await renderWith(client, <CreatorCard creator={miaCard({ followers: 5 })} />, "/creators", viewer);
    expect(container.querySelector(".pf-creator-card__stats")!.textContent).toBe("1 game · 0 plays · 5 followers");
    expect(screen.queryByRole("link", { name: "Your profile" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Follow Mia" }));
    });
    expect(follow).toHaveBeenCalledWith("mia", true);
    await waitFor(() => expect(container.querySelector(".pf-creator-card__stats")!.textContent).toBe("1 game · 0 plays · 6 followers"));
    expect(screen.getByRole("button", { name: /Mia$/ }).getAttribute("data-following")).toBe("true");
  });

  it("own card: Your profile → /me instead of Follow", async () => {
    const client = makeClient(viewer);
    await renderWith(client, <CreatorCard creator={creator("bob", { user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null } })} />, "/creators", viewer);
    const link = screen.getByRole("link", { name: "Your profile" });
    expect(link.getAttribute("href")).toBe("/me");
    expect(link.className).toBe("pf-btn pf-btn--ghost pf-btn--sm");
    expect(screen.queryByRole("button", { name: /Follow/ })).toBeNull();
  });

  it("skeleton: banner, circle and two lines, hidden from assistive tech", async () => {
    const client = makeClient(null);
    const { container } = await renderWith(client, <CreatorCardSkeleton />);
    const sk = container.querySelector(".pf-creator-card--skeleton")!;
    expect(sk.getAttribute("aria-hidden")).toBe("true");
    expect(sk.querySelectorAll(".pf-skeleton").length).toBe(4);
  });

  it("F032: headingLevel={3} renders the name as an h3 (still labelling the article)", async () => {
    const client = makeClient(null);
    await renderWith(client, <CreatorCard creator={miaCard()} headingLevel={3} />);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    const h3 = screen.getByRole("heading", { level: 3, name: "Mia" });
    expect(h3.id).toBe("creator-u2-name");
    expect(h3.className).toBe("pf-creator-card__name");
    expect(screen.getByRole("article", { name: "Mia" })).toBeTruthy();
  });
});
