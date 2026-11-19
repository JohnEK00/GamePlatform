import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../components/Layout";
import { viewer } from "./creatorFixtures";
import { makeClient, renderWith } from "./postRender";

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

describe("Layout: Creators links (F035)", () => {
  for (const signedIn of [false, true]) {
    it(`header Creators comes right after the home link (${signedIn ? "signed in" : "anonymous"})`, async () => {
      const me = signedIn ? viewer : null;
      await renderWith(makeClient(me), tree, "/", me);
      const header = document.querySelector("header")!;
      const links = Array.from(header.querySelectorAll("nav a"));
      const home = links.findIndex((a) => a.getAttribute("href") === "/" && a.textContent?.trim() === "Browse");
      expect(home).toBeGreaterThanOrEqual(0);
      expect(links[home + 1].textContent).toBe("Creators");
      expect(links[home + 1].getAttribute("href")).toBe("/creators");
    });
  }

  it("footer Creators comes right after Browse", async () => {
    await renderWith(makeClient(null), tree, "/");
    const footer = screen.getByRole("navigation", { name: "Footer" });
    const links = Array.from(footer.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);
    const i = links.findIndex(([t]) => t === "Browse");
    expect(links[i + 1]).toEqual(["Creators", "/creators"]);
  });

  it("the header link is active on /creators", async () => {
    await renderWith(makeClient(null), tree, "/creators?sort=new");
    const link = Array.from(document.querySelectorAll("header nav a")).find((a) => a.textContent === "Creators")!;
    expect(link.getAttribute("aria-current")).toBe("page");
  });
});
