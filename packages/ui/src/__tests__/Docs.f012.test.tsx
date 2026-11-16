import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import { WebGameApp } from "../WebGameApp";

describe("DocsPage (F012)", () => {
  it("has section 16 and lists fnt in the bundle layout", async () => {
    window.location.hash = "#/docs";
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={new ApiClient({ baseUrl: "" })} />);
    expect(await screen.findByRole("heading", { name: "16. Text, fonts and menus" })).toBeTruthy();
    const layout = screen.getByText(/└─ assets\/\.\.\./);
    expect(layout.textContent).toMatch(/txt fnt wav/);
    expect(document.body.textContent).toContain("loadBitmapFont");
    expect(document.body.textContent).toContain("nav: false");
    window.location.hash = "";
  });
});
