import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlAction } from "../api/types";
import { ControlsSummary } from "../components/ControlsSummary";
import { controlsStorageKey, PLAYER_CONTROLS_EVENT, resetControlsStoreForTests, writeBindings, writeOverrides } from "../controls";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "left", name: "Move left", keys: ["ArrowLeft"], gamepad: ["Left"] },
  { id: "menu", name: "Menu", keys: [], gamepad: ["Start"] },
];

afterEach(() => {
  resetControlsStoreForTests();
  vi.restoreAllMocks();
});

const items = () => screen.getAllByRole("listitem").map((li) => li.textContent);

describe("ControlsSummary", () => {
  it("renders nothing without actions and hint (older servers too)", () => {
    const { container, rerender } = render(<ControlsSummary game={{ id: "g1" }} />);
    expect(container.innerHTML).toBe("");
    rerender(<ControlsSummary game={{ id: "g1", actions: [], controlsHint: "" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the hint and the effective bindings, updated live", () => {
    localStorage.setItem(controlsStorageKey("g1"), JSON.stringify({ v: 1, overrides: { left: ["KeyA"] } }));
    render(<ControlsSummary game={{ id: "g1", actions: ACTIONS, controlsHint: "Collect the stars." }} />);
    expect(screen.getByRole("region", { name: "Controls" })).toBeTruthy();
    expect(screen.getByText("Collect the stars.")).toBeTruthy();
    expect(items()).toEqual(["Jump — Space, ↑ · A", "Move left — A · D-pad ←", "Menu — Start"]);
    act(() => {
      writeOverrides("g1", { jump: ["KeyK"] }, ACTIONS);
    });
    expect(items()).toEqual(["Jump — K · A", "Move left — ← · D-pad ←", "Menu — Start"]);
    // Another tab's change.
    localStorage.setItem(controlsStorageKey("g1"), JSON.stringify({ v: 1, overrides: { jump: [] } }));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: controlsStorageKey("g1") }));
    });
    expect(items()[0]).toBe("Jump — A");
  });

  it("shows the effective gamepad buttons, updated live (F016)", () => {
    localStorage.setItem(controlsStorageKey("g1"), JSON.stringify({ v: 1, overrides: {}, gamepad: { jump: ["B"], menu: [] } }));
    render(<ControlsSummary game={{ id: "g1", actions: ACTIONS }} />);
    expect(items()).toEqual(["Jump — Space, ↑ · B", "Move left — ← · D-pad ←", "Menu — Unbound"]);
    act(() => {
      writeBindings("g1", { keys: { left: ["KeyA"] }, gamepad: { left: ["LB", "Left"] } }, ACTIONS);
    });
    expect(items()).toEqual(["Jump — Space, ↑ · A", "Move left — A · LB, D-pad ←", "Menu — Start"]);
  });

  it("Customize dispatches PLAYER_CONTROLS_EVENT; hidden for hint-only games", () => {
    const onEvt = vi.fn();
    window.addEventListener(PLAYER_CONTROLS_EVENT, onEvt);
    const { rerender } = render(<ControlsSummary game={{ id: "g1", actions: ACTIONS }} />);
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    expect(onEvt).toHaveBeenCalledTimes(1);
    rerender(<ControlsSummary game={{ id: "g1", actions: [], controlsHint: "Mouse to aim" }} />);
    expect(screen.getByText("Mouse to aim")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Customize/ })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    window.removeEventListener(PLAYER_CONTROLS_EVENT, onEvt);
  });
});
