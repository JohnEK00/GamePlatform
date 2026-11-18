import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { User } from "../api/types";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";

const base: User = {
  id: "u1",
  username: "mia",
  displayName: "Mia",
  avatarUrl: null,
  bio: "Hi",
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
  bannerUrl: null,
  links: [],
};

async function setup(me: User) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "getNotificationSettings").mockRejectedValue(new ApiError("not_found", "nope", 404));
  const updateMe = vi.spyOn(client, "updateMe").mockImplementation(async (b) => ({ ...me, ...b, links: b.links ?? me.links }) as User);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await screen.findByRole("heading", { name: "Settings" });
  await act(async () => {});
  return { client, updateMe };
}

const addButton = () => screen.queryByRole("button", { name: "+ Add link" });
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const save = async () => act(async () => fireEvent.click(screen.getByRole("button", { name: /Save profile/ })));
const bannerPanel = () => screen.getByRole("heading", { name: "Banner" }).closest("section")!;

afterEach(() => vi.restoreAllMocks());

describe("Settings: profile links (F028 § 0.12)", () => {
  it("adds up to 3 rows (Add focuses the new label; Add hidden at 3) with the documented inputs", async () => {
    await setup(base);
    const group = screen.getByRole("group", { name: "Links" });
    expect(within(group).getByText("Up to 3 links, shown on your profile.")).toBeTruthy();
    expect(within(group).queryByLabelText("Link 1 label")).toBeNull();

    await act(async () => fireEvent.click(addButton()!));
    expect(document.activeElement).toBe(input("Link 1 label"));
    const label = input("Link 1 label");
    expect(label.placeholder).toBe("Label (optional)");
    expect(label.maxLength).toBe(30);
    const url = input("Link 1 URL");
    expect(url.type).toBe("url");
    expect(url.inputMode).toBe("url");
    expect(url.placeholder).toBe("https://…");
    expect(url.maxLength).toBe(200);
    expect(screen.getByRole("button", { name: "Remove link 1" }).textContent).toBe("Remove");

    await act(async () => fireEvent.click(addButton()!));
    expect(document.activeElement).toBe(input("Link 2 label"));
    await act(async () => fireEvent.click(addButton()!));
    expect(document.activeElement).toBe(input("Link 3 label"));
    expect(addButton()).toBeNull();
  });

  it("Remove focuses the same index's label, else the previous Remove, else + Add link", async () => {
    await setup({ ...base, links: [{ label: "A", url: "https://a.com" }, { label: "B", url: "https://b.com" }, { label: "C", url: "https://c.com" }] });
    expect(addButton()).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove link 2" })));
    expect(input("Link 2 label").value).toBe("C");
    expect(document.activeElement).toBe(input("Link 2 label"));
    expect(addButton()).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove link 2" })));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove link 1" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove link 1" })));
    expect(document.activeElement).toBe(addButton());
  });

  it("an invalid URL shows the inline error, aria-invalid, focus, and sends nothing", async () => {
    const { updateMe } = await setup({ ...base, links: [{ label: "Ok", url: "https://ok.com" }] });
    await act(async () => fireEvent.click(addButton()!));
    fireEvent.change(input("Link 2 URL"), { target: { value: "javascript:alert(1)" } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    const url = input("Link 2 URL");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    const errId = url.getAttribute("aria-describedby")!;
    const err = document.getElementById(errId)!;
    expect(err.textContent).toBe("Enter a full link starting with https:// or http://");
    expect(err.className).toContain("pf-field__error");
    expect(input("Link 1 URL").getAttribute("aria-invalid")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(url));
    // Fixing it clears the error.
    fireEvent.change(url, { target: { value: "https://fixed.dev" } });
    expect(input("Link 2 URL").getAttribute("aria-invalid")).toBeNull();
  });

  it("a label with a forbidden character (bidi override) shows the server message on the label and sends nothing", async () => {
    const { updateMe } = await setup({ ...base, links: [{ label: "Ok", url: "https://ok.com" }] });
    await act(async () => fireEvent.click(addButton()!));
    fireEvent.change(input("Link 2 label"), { target: { value: `evil${String.fromCodePoint(0x202e)}txt` } });
    fireEvent.change(input("Link 2 URL"), { target: { value: "https://fine.dev" } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    const label = input("Link 2 label");
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(label.getAttribute("aria-describedby")!)!.textContent).toBe("links[1].label must not contain control characters");
    expect(input("Link 2 URL").getAttribute("aria-invalid")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(label));
  });

  it("a leading U+FEFF and a trailing U+0085 in a label are rejected before any trim", async () => {
    const { updateMe } = await setup({ ...base, links: [] });
    await act(async () => fireEvent.click(addButton()!));
    fireEvent.change(input("Link 1 label"), { target: { value: `${String.fromCodePoint(0xfeff)}Site${String.fromCodePoint(0x85)}` } });
    fireEvent.change(input("Link 1 URL"), { target: { value: "https://mia.dev" } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    const label = input("Link 1 label");
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(label.getAttribute("aria-describedby")!)!.textContent).toBe("links[0].label must not contain control characters");
  });

  it("label length is counted in code points: 30 emoji are accepted and sent", async () => {
    const emoji30 = String.fromCodePoint(0x1f3ae).repeat(30); // 30 code points, 60 UTF-16 units
    expect(emoji30.length).toBe(60);
    const { updateMe } = await setup({ ...base, links: [{ label: emoji30, url: "https://mia.dev" }] });
    await save();
    expect(updateMe).toHaveBeenCalledWith({ displayName: "Mia", bio: "Hi", links: [{ label: emoji30, url: "https://mia.dev" }] });
  });

  it("drops empty rows and sends trimmed links with displayName and bio", async () => {
    const { updateMe } = await setup({ ...base, links: [{ label: "Site", url: "https://mia.dev" }] });
    await act(async () => fireEvent.click(addButton()!));
    fireEvent.change(input("Link 2 label"), { target: { value: "   " } });
    await act(async () => fireEvent.click(addButton()!));
    fireEvent.change(input("Link 3 label"), { target: { value: " YouTube " } });
    fireEvent.change(input("Link 3 URL"), { target: { value: " https://youtube.com/@mia " } });
    await save();
    expect(updateMe).toHaveBeenCalledWith({
      displayName: "Mia",
      bio: "Hi",
      links: [
        { label: "Site", url: "https://mia.dev" },
        { label: "YouTube", url: "https://youtube.com/@mia" },
      ],
    });
    expect(await screen.findByText("Profile saved")).toBeTruthy();
  });

  it("is hidden for an older server (no user.links) and links is then not sent", async () => {
    const { links: _links, ...old } = base;
    const { updateMe } = await setup(old as User);
    expect(screen.queryByRole("group", { name: "Links" })).toBeNull();
    expect(addButton()).toBeNull();
    await save();
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(updateMe.mock.calls[0][0]).toEqual({ displayName: "Mia", bio: "Hi" });
    expect("links" in updateMe.mock.calls[0][0]).toBe(false);
  });
});

describe("Settings: banner (F028 § 0.13)", () => {
  const pick = (file: File) => {
    const fileInput = bannerPanel().querySelector<HTMLInputElement>("input[type=file]")!;
    fireEvent.change(fileInput, { target: { files: [file] } });
  };

  it("sits between Avatar and the rest, previews 'No banner yet', uploads with progress and toasts", async () => {
    const { client } = await setup(base);
    const panelTitles = Array.from(document.querySelectorAll("h2.pf-panel__title")).map((h) => h.textContent);
    expect(panelTitles.indexOf("Banner")).toBe(panelTitles.indexOf("Avatar") + 1);
    const panel = bannerPanel();
    expect(panel.className).toContain("pf-panel");
    expect(within(panel).getByText("No banner yet")).toBeTruthy();
    expect(within(panel).getByText("PNG, JPG or WebP · ≤ 2 MB · at least 600×200 · cropped to 3:1")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Remove banner/ })).toBeNull();
    const upload = within(panel).getByRole("button", { name: /Upload banner/ });
    expect(upload.getAttribute("aria-disabled")).toBe("true");

    let finish: (u: User) => void = () => {};
    const spy = vi.spyOn(client, "uploadBanner").mockImplementation((_f, onProgress) => {
      onProgress?.({ loaded: 1, total: 2, fraction: 0.5 });
      return new Promise<User>((resolve) => {
        finish = resolve;
      });
    });
    const file = new File([new Uint8Array(1000)], "wide.png", { type: "image/png" });
    await act(async () => pick(file));
    expect(upload.getAttribute("aria-disabled")).toBe("false");
    await act(async () => fireEvent.click(upload));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(file);
    const bar = within(bannerPanel()).getByRole("progressbar", { name: "Uploading banner" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(upload.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish({ ...base, bannerUrl: "/media/banners/u1.jpg?v=1" }));
    expect(await screen.findByText("Banner updated")).toBeTruthy();
    expect(within(bannerPanel()).queryByRole("progressbar")).toBeNull();
    const img = within(bannerPanel()).getByRole("img", { name: "Your current banner" });
    expect(img.getAttribute("src")).toBe("http://api.test/media/banners/u1.jpg?v=1");
  });

  it("rejects a file over 2 MB without a request", async () => {
    const { client } = await setup(base);
    const spy = vi.spyOn(client, "uploadBanner");
    await act(async () => pick(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" })));
    await act(async () => fireEvent.click(within(bannerPanel()).getByRole("button", { name: /Upload banner/ })));
    expect(within(bannerPanel()).getByRole("alert").textContent).toBe("Banners can be at most 2 MB.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("server errors go in the panel's alert", async () => {
    const { client } = await setup(base);
    vi.spyOn(client, "uploadBanner").mockRejectedValue(new ApiError("validation", "banner must be at least 600×200 pixels after cropping to 3:1", 422));
    await act(async () => pick(new File([new Uint8Array(10)], "small.png", { type: "image/png" })));
    await act(async () => fireEvent.click(within(bannerPanel()).getByRole("button", { name: /Upload banner/ })));
    expect(within(bannerPanel()).getByRole("alert").textContent).toBe("banner must be at least 600×200 pixels after cropping to 3:1");
  });

  it("Remove banner calls deleteBanner, toasts and moves focus to Upload banner", async () => {
    const { client } = await setup({ ...base, bannerUrl: "/media/banners/u1.jpg?v=3" });
    const panel = bannerPanel();
    expect(within(panel).getByRole("img", { name: "Your current banner" })).toBeTruthy();
    const del = vi.spyOn(client, "deleteBanner").mockResolvedValue({ ...base, bannerUrl: null });
    const remove = within(panel).getByRole("button", { name: /Remove banner/ });
    expect(remove.className).toContain("pf-btn--ghost");
    await act(async () => fireEvent.click(remove));
    expect(del).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Banner removed")).toBeTruthy();
    expect(within(bannerPanel()).queryByRole("button", { name: /Remove banner/ })).toBeNull();
    expect(within(bannerPanel()).getByText("No banner yet")).toBeTruthy();
    expect(document.activeElement).toBe(within(bannerPanel()).getByRole("button", { name: /Upload banner/ }));
  });

  it("is hidden for an older server (bannerUrl undefined)", async () => {
    const { bannerUrl: _b, ...old } = base;
    await setup(old as User);
    expect(screen.queryByRole("heading", { name: "Banner" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Avatar" })).toBeTruthy();
  });
});
