import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import { WebGameApp } from "../WebGameApp";

const ROWS = [
  ["D-pad", "move"],
  ["A", "press"],
  ["B", "cancel"],
  ["X", "delete"],
  ["Y", "space"],
  ["LB", "shift"],
  ["Start", "OK"],
  ["Tap", "press"],
];

describe("DocsPage (F023)", () => {
  it("documents the on-screen keyboard inside section 16, after the F019 subsection", async () => {
    window.location.hash = "#/docs";
    try {
      render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={new ApiClient({ baseUrl: "" })} />);
      const s16 = await screen.findByRole("heading", { level: 2, name: "16. Text, fonts and menus" });
      const section = s16.closest("section")!;

      const sub = screen.getByRole("heading", { level: 3, name: "On-screen keyboard (F023)" });
      expect(section.contains(sub)).toBe(true);
      const f019 = within(section).getByRole("heading", { level: 3, name: "Settings and text entry (F019)" });
      expect(f019.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // The controls table: 8 rows in the spec's order, after the subsection heading.
      const table = within(section).getByRole("table", { name: "On-screen keyboard controls" });
      expect(sub.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const body = table.querySelector("tbody")!;
      const rows = within(body).getAllByRole("row");
      expect(rows).toHaveLength(ROWS.length);
      rows.forEach((row, i) => {
        const cells = within(row).getAllByRole("cell");
        expect(cells[0].textContent).toBe(ROWS[i][0]);
        expect(cells[1].textContent?.toLowerCase()).toContain(ROWS[i][1].toLowerCase());
      });

      // The snippet and keyboardRect.
      const snippet = Array.from(section.querySelectorAll("pre code")).find((c) => c.textContent?.includes("keyboard:"));
      expect(snippet?.textContent).toContain('ui.textField("name", s.name, 120, 120, 160, 16, { keyboard: "never" })');
      const text = section.textContent ?? "";
      expect(text).toContain("keyboardRect");
      for (const mode of ['"auto"', '"always"', '"never"']) expect(text).toContain(mode);

      // The F019 touch/controller bullet points to the keyboard now.
      const bullet = within(section)
        .getAllByRole("listitem")
        .find((li) => li.textContent?.startsWith("Touch and controller players:"));
      expect(bullet).toBeTruthy();
      const bulletText = (bullet!.textContent ?? "").replace(/\s+/g, " ");
      expect(bulletText).not.toContain("there is no on-screen keyboard yet");
      expect(bulletText).toBe("Touch and controller players: an on-screen keyboard opens when they start typing (see below).");
    } finally {
      window.location.hash = "";
    }
  });
});
