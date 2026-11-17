import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import { DOCS_SECTIONS } from "../pages/DocsPage";
import { WebGameApp } from "../WebGameApp";

const TITLES = [
  "Bundle layout",
  "game.json",
  "The game module",
  "Engine API at a glance",
  "Scores & leaderboards",
  "Achievements",
  "Save data",
  "Debug overlay",
  "Game Studio",
  "Limits & rules",
  "Your players can follow you",
  "Publishing: tags & discovery",
  "Release notes",
  "Screenshots",
  "Actions and remapping",
  "Text, fonts and menus",
];

describe("DocsPage (F019)", () => {
  it("adds 'Settings and text entry (F019)' inside section 16 without renumbering", async () => {
    window.location.hash = "#/docs";
    try {
      render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={new ApiClient({ baseUrl: "" })} />);
      const s16 = await screen.findByRole("heading", { level: 2, name: "16. Text, fonts and menus" });
      expect(DOCS_SECTIONS.map((s) => s.title)).toEqual(TITLES);
      expect(screen.getAllByRole("heading", { level: 2 }).filter((h) => /^\d+\. /.test(h.textContent ?? "")).map((h) => h.textContent)).toEqual(
        TITLES.map((t, i) => `${i + 1}. ${t}`),
      );

      const sub = screen.getByRole("heading", { level: 3, name: "Settings and text entry (F019)" });
      const section = s16.closest("section")!;
      expect(section.contains(sub)).toBe(true);
      // It follows "Menus and buttons" in the same section.
      const menus = within(section).getByRole("heading", { level: 3, name: "Menus and buttons" });
      expect(menus.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const text = section.textContent ?? "";
      for (const s of ["ui.slider(", "ui.committed(", "ui.toggle(", "ui.textField(", "allow:", "ui.list(", "selected:", "keyboardCaptured", "lastDevice"]) {
        expect(text).toContain(s);
      }
      const table = within(section).getByRole("table", { name: "Keys and gamepad, by focused widget" });
      expect(within(table).getAllByRole("row")).toHaveLength(6);

      // Review 8, L2: the fullscreen Escape caveat.
      const escItem = within(section)
        .getAllByRole("listitem")
        .find((li) => li.textContent?.startsWith("Escape in fullscreen:"));
      expect(escItem).toBeTruthy();
      const escText = (escItem!.textContent ?? "").replace(/\s+/g, " ");
      expect(escText).toContain("the browser takes the first Escape to leave fullscreen");
      expect(escText).toContain("use gamepad B or press Escape again");
      expect(escText).toContain("Enter, clicking elsewhere and Up/Down still end editing");
    } finally {
      window.location.hash = "";
    }
  });
});
