import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { HeartButton, type HeartState } from "../components/HeartButton";
import { WebGameProviders } from "../WebGameApp";
import { deferred, miaRef } from "./postReplyFixtures";

afterEach(() => vi.restoreAllMocks());

function setup(initial: HeartState, opts: { onToggle?: (on: boolean) => Promise<HeartState>; subject?: "comment" | "post"; interactive?: boolean } = {}) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const setCommentHeart = vi.spyOn(client, "setCommentHeart");
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <HeartButton comment={{ id: "p1", author: miaRef, ...initial }} interactive={opts.interactive ?? true} subject={opts.subject} onToggle={opts.onToggle} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { client, setCommentHeart };
}

describe("HeartButton subject and onToggle (F031)", () => {
  it("subject='post' changes the aria-label", () => {
    setup({ hearts: 2, myHeart: false, creatorHeart: false }, { subject: "post" });
    expect(screen.getByRole("button", { name: "Heart post by Mia, 2 hearts" })).toBeTruthy();
  });

  it("defaults to 'comment'", () => {
    setup({ hearts: 1, myHeart: false, creatorHeart: false });
    expect(screen.getByRole("button", { name: "Heart comment by Mia, 1 heart" })).toBeTruthy();
  });

  it("onToggle replaces setCommentHeart, with an optimistic update reconciled with its result", async () => {
    const d = deferred<HeartState>();
    const onToggle = vi.fn(() => d.promise);
    const { setCommentHeart } = setup({ hearts: 2, myHeart: false, creatorHeart: false }, { subject: "post", onToggle });
    const btn = screen.getByRole("button", { name: "Heart post by Mia, 2 hearts" });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(setCommentHeart).not.toHaveBeenCalled();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Heart post by Mia, 3 hearts");
    // In flight: further clicks are ignored.
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ hearts: 5, myHeart: true, creatorHeart: false }));
    expect(btn.getAttribute("aria-label")).toBe("Heart post by Mia, 5 hearts");
  });

  it("rolls back and toasts on failure", async () => {
    const onToggle = vi.fn(async () => {
      throw new ApiError("validation", "You can't heart your own post", 422);
    });
    setup({ hearts: 2, myHeart: false, creatorHeart: false }, { subject: "post", onToggle });
    const btn = screen.getByRole("button", { name: "Heart post by Mia, 2 hearts" });
    await act(async () => fireEvent.click(btn));
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Heart post by Mia, 2 hearts");
    expect(await screen.findByText("You can't heart your own post")).toBeTruthy();
  });

  it("un-hearting calls onToggle(false)", async () => {
    const onToggle = vi.fn(async () => ({ hearts: 0, myHeart: false, creatorHeart: false }));
    setup({ hearts: 1, myHeart: true, creatorHeart: false }, { subject: "post", onToggle });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Heart post by Mia, 1 heart" })));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Heart post by Mia" }).getAttribute("aria-pressed")).toBe("false");
  });
});
