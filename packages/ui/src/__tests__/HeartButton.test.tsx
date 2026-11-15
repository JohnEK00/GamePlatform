import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { HeartResponse } from "../api/types";
import { HeartButton, type HeartState } from "../components/HeartButton";
import { WebGameProviders } from "../WebGameApp";

const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ initial, interactive, onChange }: { initial: HeartState; interactive: boolean; onChange?: (s: HeartState) => void }) {
  const [state, setState] = useState(initial);
  return (
    <HeartButton
      comment={{ id: "c1", author: alice, ...state }}
      interactive={interactive}
      onChange={(s) => {
        setState(s);
        onChange?.(s);
      }}
    />
  );
}

function setup(initial: HeartState, interactive = true) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const onChange = vi.fn();
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <Harness initial={initial} interactive={interactive} onChange={onChange} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { client, onChange };
}

describe("HeartButton (F006)", () => {
  it("is a toggle with aria-pressed and a descriptive label; the count is hidden when 0", () => {
    setup({ hearts: 0, myHeart: false, creatorHeart: false });
    const btn = screen.getByRole("button", { name: "Heart comment by Alice" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toBe("♥");
  });

  it("toggles optimistically and reconciles with the response", async () => {
    const { client, onChange } = setup({ hearts: 2, myHeart: false, creatorHeart: false });
    const d = deferred<HeartResponse>();
    const put = vi.spyOn(client, "heartComment").mockReturnValue(d.promise);
    const btn = screen.getByRole("button", { name: "Heart comment by Alice, 2 hearts" });
    fireEvent.click(btn);
    expect(put).toHaveBeenCalledWith("c1");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Heart comment by Alice, 3 hearts");
    expect(btn.querySelector(".pf-heart__count")!.getAttribute("aria-hidden")).toBe("true");
    // The server says someone else hearted meanwhile, and the creator too.
    await act(async () => d.resolve({ hearted: true, hearts: 5, creatorHeart: true }));
    expect(btn.getAttribute("aria-label")).toBe("Heart comment by Alice, 5 hearts");
    expect(screen.getByRole("img", { name: "Hearted by the creator" }).textContent).toBe("♥ Creator");
    expect(onChange).toHaveBeenLastCalledWith({ myHeart: true, hearts: 5, creatorHeart: true });
  });

  it("reverts and shows a toast on error", async () => {
    const { client } = setup({ hearts: 1, myHeart: true, creatorHeart: false });
    vi.spyOn(client, "unheartComment").mockRejectedValue(new ApiError("rate_limited", "Slow down, try again in 9s.", 429, 9));
    const btn = screen.getByRole("button", { name: /Heart comment by Alice/ });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await screen.findByText("Slow down, try again in 9s.");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Heart comment by Alice, 1 heart");
  });

  it("ignores clicks while a request is in flight but stays enabled and focused", async () => {
    const { client } = setup({ hearts: 0, myHeart: false, creatorHeart: false });
    const d = deferred<HeartResponse>();
    const put = vi.spyOn(client, "heartComment").mockReturnValue(d.promise);
    const del = vi.spyOn(client, "unheartComment");
    const btn = screen.getByRole("button", { name: /Heart comment/ });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await act(async () => d.resolve({ hearted: true, hearts: 1, creatorHeart: false }));
    del.mockResolvedValue({ hearted: false, hearts: 0, creatorHeart: false });
    fireEvent.click(btn);
    expect(del).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("false"));
  });

  it("is a plain count for the author or anonymous visitors (hidden when 0)", () => {
    setup({ hearts: 3, myHeart: false, creatorHeart: true }, false);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "3 hearts" }).tagName).toBe("SPAN");
    expect(screen.getByRole("img", { name: "Hearted by the creator" })).toBeTruthy();
  });

  it("renders nothing for a non-interactive zero count", () => {
    const { container } = render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }}>
        <HeartButton comment={{ id: "c1", author: alice, hearts: 0, myHeart: false, creatorHeart: false }} interactive={false} />
      </WebGameProviders>,
    );
    expect(container.querySelector(".pf-heart")).toBeNull();
  });
});
