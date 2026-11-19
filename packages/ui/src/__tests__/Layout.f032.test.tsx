import { act, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../components/Layout";
import { currentLocation, makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const tree = (
  <Routes>
    <Route element={<Layout />}>
      <Route path="*" element={<p>page</p>} />
    </Route>
  </Routes>
);

const searchInput = () => screen.getByRole("searchbox", { name: "Search games" }) as HTMLInputElement;

describe("Layout links (F032)", () => {
  it("nav Browse is the first link and points at /browse; the logo stays /", async () => {
    await renderWith(makeClient(null), tree, "/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const first = nav.querySelector("a")!;
    expect(first.textContent).toBe("Browse");
    expect(first.getAttribute("href")).toBe("/browse");
    expect(screen.getByRole("link", { name: "Pixelforge Arcade home" }).getAttribute("href")).toBe("/");
  });

  it("nav Browse is active on /browse (with a query) and not on /", async () => {
    const { unmount } = await renderWith(makeClient(null), tree, "/browse?sort=top");
    const link = () => screen.getByRole("navigation", { name: "Main" }).querySelector("a")!;
    expect(link().getAttribute("aria-current")).toBe("page");
    unmount();
    await renderWith(makeClient(null), tree, "/");
    expect(link().getAttribute("aria-current")).toBeNull();
  });

  it("footer Browse points at /browse", async () => {
    await renderWith(makeClient(null), tree, "/");
    const footer = screen.getByRole("navigation", { name: "Footer" });
    const browse = Array.from(footer.querySelectorAll("a")).find((a) => a.textContent === "Browse")!;
    expect(browse.getAttribute("href")).toBe("/browse");
  });

  it("search submits to /browse?q={trimmed}, blank to /browse", async () => {
    await renderWith(makeClient(null), tree, "/creators");
    fireEvent.change(searchInput(), { target: { value: "  dodge " } });
    await act(async () => fireEvent.submit(searchInput().closest("form")!));
    expect(currentLocation()).toBe("/browse?q=dodge");
    fireEvent.change(searchInput(), { target: { value: "   " } });
    await act(async () => fireEvent.submit(searchInput().closest("form")!));
    expect(currentLocation()).toBe("/browse");
  });

  it("the input mirrors ?q on /browse, not on /", async () => {
    const { unmount } = await renderWith(makeClient(null), tree, "/browse?q=dodge");
    expect(searchInput().value).toBe("dodge");
    unmount();
    await renderWith(makeClient(null), tree, "/?q=dodge");
    expect(searchInput().value).toBe("");
  });
});
