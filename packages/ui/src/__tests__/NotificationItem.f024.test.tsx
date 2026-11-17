import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Notification } from "../api/types";
import { NotificationItem } from "../components/NotificationItem";
import { WebGameProviders } from "../WebGameApp";
import { notif } from "./notifFixtures";

const THUMB = "/media/screenshots/s1_t.jpg";

const shot = (over: Partial<Notification> = {}): Notification =>
  notif({
    id: "24",
    kind: "screenshotPosted",
    commentId: null,
    excerpt: null,
    path: "/games/g1?section=screenshots",
    screenshot: { id: "s1", thumbUrl: THUMB },
    ...over,
  });

function renderItem(item: Notification, extra: { variant?: "panel" | "page"; showMute?: boolean } = {}) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const onMute = vi.fn();
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <ul>
          <NotificationItem item={item} variant={extra.variant} showMute={extra.showMute} onMute={onMute} />
        </ul>
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { ...utils, client, onMute };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationItem screenshotPosted (F024 § 0.9)", () => {
  it("one link to the gallery with the summary, the 📷 glyph and a decorative thumbnail", () => {
    const { container, client } = renderItem(shot());
    const li = container.querySelector("li")!;
    const links = li.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link.getAttribute("href")).toBe("/games/g1?section=screenshots");
    expect(container.querySelector(".pf-notif__text")!.textContent).toBe("Unread: Mia posted a screenshot of Pixel Peaks");

    const imgs = link.querySelectorAll("img.pf-notif__shot");
    expect(imgs).toHaveLength(1);
    const img = imgs[0] as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("src")).toBe(client.url(THUMB));
    expect(img.getAttribute("src")).toBe("http://api.test/media/screenshots/s1_t.jpg");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("width")).toBe("48");
    expect(img.getAttribute("height")).toBe("48");
    // after the body, before the unread dot
    expect(img.previousElementSibling?.classList.contains("pf-notif__body")).toBe(true);
    expect(img.nextElementSibling?.classList.contains("pf-notif__dot")).toBe(true);

    const glyph = link.querySelector(".pf-notif__kind--screenshot")!;
    expect(glyph.textContent).toBe("📷");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.classList.contains("pf-notif__kind")).toBe(true);

    expect(container.querySelector(".pf-notif__excerpt")).toBeNull();
  });

  it("no image when screenshot is null or missing; the rest renders", () => {
    const { container, unmount } = renderItem(shot({ screenshot: null }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".pf-notif__kind--screenshot")).not.toBeNull();
    expect(container.querySelector(".pf-notif__text")!.textContent).toContain("Mia posted a screenshot of Pixel Peaks");
    unmount();
    const missing = shot();
    delete (missing as Partial<Notification>).screenshot;
    const second = renderItem(missing);
    expect(second.container.querySelector("img")).toBeNull();
  });

  it("page variant with showMute: one link plus the 'Mute game' button", () => {
    const { container, onMute } = renderItem(shot({ eventCount: 2 }), { variant: "page", showMute: true });
    const li = container.querySelector("li")!;
    expect(li.querySelectorAll("a")).toHaveLength(1);
    const btn = li.querySelector("button.pf-notif__mute") as HTMLButtonElement;
    expect(btn.textContent).toBe("Mute game");
    expect(btn.getAttribute("aria-label")).toBe("Mute game: Pixel Peaks");
    btn.click();
    expect(onMute).toHaveBeenCalledWith(expect.objectContaining({ id: "24" }), { target: "game", id: "g1", label: "Mute game: Pixel Peaks" });
    expect(li.querySelectorAll("a img")).toHaveLength(1);
    expect(container.querySelector(".pf-notif__text")!.textContent).toBe("Unread: Mia posted 2 screenshots of Pixel Peaks");
  });

  it("other kinds never render the thumbnail or the 📷 glyph", () => {
    const { container } = renderItem(notif({ id: "1", screenshot: { id: "s1", thumbUrl: THUMB } }));
    expect(container.querySelector("img.pf-notif__shot")).toBeNull();
    expect(container.querySelector(".pf-notif__kind--screenshot")).toBeNull();
  });
});
