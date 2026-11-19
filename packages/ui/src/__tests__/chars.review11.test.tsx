// Review 11 L1/L2 (client side): the shared forbidden-character set, mirrored from the server, on link labels, the
// display name and bio (Settings) and post bodies. ASCII-only: characters are built with String.fromCodePoint.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { User } from "../api/types";
import { SettingsPage } from "../pages/SettingsPage";
import { POST_CHARS_MESSAGE, POST_LINES_MESSAGE, validatePostBody } from "../posts";
import {
  BIO_CHARS_MESSAGE,
  DISPLAY_NAME_CHARS_MESSAGE,
  hasForbiddenProfileChar,
  isForbiddenLabelCodePoint,
  validateBio,
  validateDisplayName,
  validateProfileLinkLabel,
} from "../profile";
import { WebGameProviders } from "../WebGameApp";

const ch = (cp: number) => String.fromCodePoint(cp);

/** The F028 set. */
const F028: number[] = [
  0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
];
/** Added in review 11. */
const ADDED: number[] = [0x061c, 0x115f, 0x1160, 0x180e, 0x2028, 0x2029, 0x3164, 0xffa0];
/** Neighbours that stay allowed. */
const ALLOWED: number[] = [
  0x20, 0x7e, 0xa0, 0xad, 0x061b, 0x061d, 0x115e, 0x1161, 0x180d, 0x180f, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2065, 0x206a,
  0x3000, 0x3163, 0x3165, 0xfefe, 0xff9f, 0xffa1, 0xe9, 0x65e5, 0x1f3ae,
];

describe("isForbiddenLabelCodePoint: the shared set", () => {
  it.each([...F028, ...ADDED].map((cp) => [cp.toString(16), cp]))("U+%s is forbidden", (_hex, cp) => {
    expect(isForbiddenLabelCodePoint(cp)).toBe(true);
  });
  it.each(ALLOWED.map((cp) => [cp.toString(16), cp]))("U+%s is allowed", (_hex, cp) => {
    expect(isForbiddenLabelCodePoint(cp)).toBe(false);
  });
  it("C0 and C1 ranges are forbidden throughout", () => {
    for (let cp = 0; cp < 0x20; cp++) expect(isForbiddenLabelCodePoint(cp)).toBe(true);
    for (let cp = 0x7f; cp <= 0x9f; cp++) expect(isForbiddenLabelCodePoint(cp)).toBe(true);
  });
});

describe("link labels", () => {
  it.each(ADDED.map((cp) => [cp.toString(16), cp]))("rejects U+%s", (_hex, cp) => {
    expect(validateProfileLinkLabel(`My${ch(cp)}site`, 0)).toBe("links[0].label must not contain control characters");
  });
  it("checks the raw label: a trailing U+2028 (White_Space, trimmed by the server) is rejected", () => {
    expect(validateProfileLinkLabel(`Site${ch(0x2028)}`, 2)).toBe("links[2].label must not contain control characters");
    expect(validateProfileLinkLabel(`${ch(0x2029)}Site`, 2)).toBe("links[2].label must not contain control characters");
  });
  it("a Hangul filler label (looks blank) is rejected", () => {
    expect(validateProfileLinkLabel(ch(0x3164).repeat(3), 0)).toBe("links[0].label must not contain control characters");
  });
});

describe("display name and bio", () => {
  it("the display name forbids the whole set, including LF, on the raw text", () => {
    expect(validateDisplayName("Mia")).toBeNull();
    expect(validateDisplayName(`Mia ${ch(0xe9)}${ch(0x1f3ae)}`)).toBeNull();
    for (const cp of [...F028, ...ADDED]) expect(validateDisplayName(`Mi${ch(cp)}a`)).toBe(DISPLAY_NAME_CHARS_MESSAGE);
    expect(validateDisplayName(`Mia${ch(0x202e)}`)).toBe("displayName must not contain control characters");
    expect(validateDisplayName(`mia${ch(0x200b)}`)).toBe(DISPLAY_NAME_CHARS_MESSAGE);
    // Before trimming: a trailing LINE SEPARATOR or a leading BOM.
    expect(validateDisplayName(`Mia${ch(0x2028)}`)).toBe(DISPLAY_NAME_CHARS_MESSAGE);
    expect(validateDisplayName(`${ch(0xfeff)}Mia`)).toBe(DISPLAY_NAME_CHARS_MESSAGE);
    expect(validateDisplayName("Mia\n")).toBe(DISPLAY_NAME_CHARS_MESSAGE);
  });

  it("the bio allows LF only", () => {
    expect(validateBio("Line 1\nLine 2\n\nLine 4")).toBeNull();
    expect(validateBio("")).toBeNull();
    expect(validateBio("a\tb")).toBe("bio must not contain control characters");
    expect(validateBio("a\r\nb")).toBe(BIO_CHARS_MESSAGE);
    for (const cp of ADDED) expect(validateBio(`a${ch(cp)}b`)).toBe(BIO_CHARS_MESSAGE);
    expect(validateBio(`Hi${ch(0x2029)}`)).toBe(BIO_CHARS_MESSAGE);
  });

  it("hasForbiddenProfileChar handles non-strings", () => {
    expect(hasForbiddenProfileChar(undefined as unknown as string)).toBe(false);
    expect(hasForbiddenProfileChar("\n", true)).toBe(false);
    expect(hasForbiddenProfileChar("\n")).toBe(true);
  });
});

describe("post bodies (review 11 L2)", () => {
  it("30 lines joined with U+2028 no longer pass (the line-cap bypass)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    expect(validatePostBody(lines.join(ch(0x2028)))).toBe(POST_CHARS_MESSAGE);
    expect(validatePostBody(lines.join(ch(0x2029)))).toBe(POST_CHARS_MESSAGE);
    expect(validatePostBody(lines.join("\n"))).toBe(POST_LINES_MESSAGE);
  });
  it("rejects every added character, and LF is still allowed", () => {
    for (const cp of ADDED) expect(validatePostBody(`Hello${ch(cp)}world`)).toBe(POST_CHARS_MESSAGE);
    expect(validatePostBody(`Hello${ch(0x2028)}`)).toBe(POST_CHARS_MESSAGE);
    expect(validatePostBody("Hello\nworld")).toBeNull();
  });
});

describe("Settings: display name and bio characters (review 11 L1)", () => {
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

  async function setup() {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test", fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch });
    vi.spyOn(client, "me").mockResolvedValue(base);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
    vi.spyOn(client, "getNotificationSettings").mockRejectedValue(new ApiError("not_found", "nope", 404));
    const updateMe = vi.spyOn(client, "updateMe").mockImplementation(async (b) => ({ ...base, ...b, links: b.links ?? base.links }) as User);
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/settings"]}>
          <SettingsPage />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await screen.findByRole("heading", { name: "Settings" });
    await act(async () => {});
    return { updateMe };
  }

  const save = async () => act(async () => fireEvent.click(screen.getByRole("button", { name: /Save profile/ })));
  const nameInput = () => screen.getByLabelText("Display name") as HTMLInputElement;
  const bioInput = () => screen.getByLabelText("Bio") as HTMLTextAreaElement;

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("a bidi override in the display name blocks the save with the server's message and focuses the field", async () => {
    const { updateMe } = await setup();
    fireEvent.change(nameInput(), { target: { value: `Mia${ch(0x202e)}` } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    expect(screen.getByText("displayName must not contain control characters")).toBeTruthy();
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toBe("pf-displayname-error");
    expect(document.activeElement).toBe(nameInput());
    // Fixing it clears the error live and the save goes through (trimmed).
    fireEvent.change(nameInput(), { target: { value: " Mia " } });
    expect(screen.queryByText("displayName must not contain control characters")).toBeNull();
    await save();
    expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Mia" }));
  });

  it("a trailing U+2028 in the display name is rejected on the raw text, before the trim", async () => {
    const { updateMe } = await setup();
    fireEvent.change(nameInput(), { target: { value: `Mia${ch(0x2028)}` } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    expect(screen.getByText(DISPLAY_NAME_CHARS_MESSAGE)).toBeTruthy();
  });

  it("the bio allows new lines but not a Hangul filler; the bio field gets focus", async () => {
    const { updateMe } = await setup();
    fireEvent.change(bioInput(), { target: { value: `Hello${ch(0x3164)}` } });
    await save();
    expect(updateMe).not.toHaveBeenCalled();
    expect(screen.getByText("bio must not contain control characters")).toBeTruthy();
    expect(bioInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(bioInput());
    fireEvent.change(bioInput(), { target: { value: "Line 1\nLine 2" } });
    await save();
    expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ bio: "Line 1\nLine 2" }));
    expect(screen.queryByText(BIO_CHARS_MESSAGE)).toBeNull();
  });

  it("with both invalid, the display name (first in DOM order) gets focus and both errors show", async () => {
    await setup();
    fireEvent.change(nameInput(), { target: { value: `M${ch(0x061c)}ia` } });
    fireEvent.change(bioInput(), { target: { value: `b${ch(0x180e)}io` } });
    await save();
    expect(screen.getByText(DISPLAY_NAME_CHARS_MESSAGE)).toBeTruthy();
    expect(screen.getByText(BIO_CHARS_MESSAGE)).toBeTruthy();
    expect(document.activeElement).toBe(nameInput());
  });
});
