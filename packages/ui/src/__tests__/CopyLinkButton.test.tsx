import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyLinkButton } from "../components/CopyLinkButton";
import { LINK_COPIED_MS } from "../share";

const URL_ = "https://arcade.example/u/mia";
const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (clipboardDesc) Object.defineProperty(navigator, "clipboard", clipboardDesc);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

const button = () => screen.getByRole("button", { name: /Copy link|Link copied/ });

describe("CopyLinkButton", () => {
  it("copies, shows 'Link copied' for 2000 ms and announces it politely", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    setClipboard({ writeText });
    render(<CopyLinkButton url={URL_} />);
    expect(button().textContent).toBe("🔗 Copy link");
    expect(button().className).toBe("pf-btn pf-btn--ghost pf-btn--sm");
    expect(button().querySelector("[aria-hidden=true]")!.textContent).toBe("🔗");

    await act(async () => fireEvent.click(button()));
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(button().textContent).toBe("🔗 Link copied");
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Link copied");
    expect(screen.queryByLabelText("Copy this link")).toBeNull();

    await act(async () => vi.advanceTimersByTime(LINK_COPIED_MS - 1));
    expect(button().textContent).toBe("🔗 Link copied");
    await act(async () => vi.advanceTimersByTime(1));
    expect(LINK_COPIED_MS).toBe(2000);
    expect(button().textContent).toBe("🔗 Copy link");
  });

  it("a rejected write shows a focused, selected 'Copy this link' field with the URL", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    render(<CopyLinkButton url={URL_} />);
    await act(async () => fireEvent.click(button()));
    const input = screen.getByLabelText("Copy this link") as HTMLInputElement;
    expect(input.value).toBe(URL_);
    expect(input.readOnly).toBe(true);
    expect(input.className).toBe("pf-input pf-input--sm");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(URL_.length);
    expect(button().textContent).toBe("🔗 Copy link");
  });

  it("no clipboard API also falls back to the field", async () => {
    setClipboard(undefined);
    render(<CopyLinkButton url={URL_} />);
    await act(async () => fireEvent.click(button()));
    expect((screen.getByLabelText("Copy this link") as HTMLInputElement).value).toBe(URL_);
  });

  it("renders the fallback field into a given container", async () => {
    setClipboard(undefined);
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    try {
      render(<CopyLinkButton url={URL_} fallbackContainer={slot} />);
      await act(async () => fireEvent.click(button()));
      const input = slot.querySelector("input")!;
      expect(input.value).toBe(URL_);
      expect(document.activeElement).toBe(input);
    } finally {
      slot.remove();
    }
  });
});
