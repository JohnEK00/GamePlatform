import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlAction, ControlBindings, ControlOverrides, GamepadOverrides } from "../api/types";
import { ControlsPanel, type ControlsSyncState } from "../components/ControlsPanel";
import { GAMEPAD_CAPTURE_TIMEOUT_MS } from "../components/GamepadCaptureButton";
import { KEY_CAPTURE_TIMEOUT_MS } from "../components/KeyCaptureButton";
import { installFakeGamepads, type FakeGamepads } from "./fakeGamepads";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
  { id: "pause", name: "Pause", keys: [], gamepad: ["Start", "Up"] },
];

const B = (keys: ControlOverrides = {}, gamepad: GamepadOverrides = {}): ControlBindings => ({ keys, gamepad });

function Harness({
  actions = ACTIONS,
  initial = B(),
  onChange,
  onClose = () => {},
  hint,
  syncState,
}: {
  actions?: ControlAction[];
  initial?: ControlBindings;
  onChange?: (b: ControlBindings) => void;
  onClose?: () => void;
  hint?: string;
  syncState?: ControlsSyncState;
}) {
  const [b, setB] = useState<ControlBindings>(initial);
  return (
    <ControlsPanel
      mode="player"
      title="Pixel Peaks"
      hint={hint}
      actions={actions}
      bindings={b}
      syncState={syncState}
      onChange={(n) => {
        onChange?.(n);
        setB(n);
      }}
      onClose={onClose}
    />
  );
}

const slot = (action: string, n: number) => screen.getByRole("button", { name: new RegExp(`^${action}, key ${n}: `) });
const pad = (action: string, n: number) => screen.getByRole("button", { name: new RegExp(`^${action}, gamepad button ${n}: `) });
const row = (action: string) => screen.getByRole("rowheader", { name: new RegExp(`^${action}`) }).closest("tr") as HTMLTableRowElement;

function press(target: Element, code: string, key = code) {
  fireEvent.keyDown(target, { code, key });
}

let pads: FakeGamepads;
beforeEach(() => {
  pads = installFakeGamepads();
});
afterEach(() => {
  pads.uninstall();
  vi.useRealTimers();
});

describe("ControlsPanel", () => {
  it("shows the hint, the rows in manifest order, key slots and gamepad slots", () => {
    render(<Harness hint="Arrows move, Space jumps" />);
    expect(screen.getByRole("dialog", { name: "Controls" })).toBeTruthy();
    expect(screen.getByText("Pixel Peaks")).toBeTruthy();
    expect(screen.getByText("Arrows move, Space jumps")).toBeTruthy();
    const names = screen.getAllByRole("rowheader").map((th) => th.querySelector("span")!.textContent);
    expect(names).toEqual(["Jump", "Fire", "Pause"]);
    expect(slot("Jump", 1).textContent).toBe("Space");
    expect(slot("Jump", 2).textContent).toBe("↑");
    expect(slot("Jump", 3).textContent).toBe("—");
    expect(pad("Jump", 1).textContent).toBe("A");
    expect(pad("Jump", 2).textContent).toBe("—");
    expect(pad("Fire", 1).textContent).toBe("—");
    expect(pad("Pause", 1).textContent).toBe("Start");
    expect(pad("Pause", 2).textContent).toBe("D-pad ↑");
    expect(screen.getByRole("button", { name: "Clear gamepad D-pad ↑ from Pause" })).toBeTruthy();
    // Key and gamepad clear buttons have distinct names even for the same label.
    expect(screen.getByRole("button", { name: "Clear gamepad A from Jump" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear A from Jump" })).toBeNull();
    expect(screen.getByText("Saved on this device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
  });

  it("capture assigns the next key to the slot", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Jump", 3);
    fireEvent.click(s);
    expect(s.textContent).toBe("Press a key…");
    expect(screen.getByText("Press a key for Jump, or Escape to cancel")).toBeTruthy();
    press(s, "KeyK", "k");
    expect(onChange).toHaveBeenLastCalledWith(B({ jump: ["Space", "ArrowUp", "KeyK"] }));
    expect(slot("Jump", 3).textContent).toBe("K");
    expect(within(row("Jump")).getByText("Changed")).toBeTruthy();
  });

  it("Escape cancels capture without closing the panel", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onChange={onChange} onClose={onClose} />);
    const s = slot("Jump", 1);
    fireEvent.click(s);
    press(s, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(slot("Jump", 1).textContent).toBe("Space");
    press(s, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a non-bindable key keeps capture mode and says so", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Fire", 2);
    fireEvent.click(s);
    press(s, "Tab");
    expect(screen.getByText("Tab can't be used")).toBeTruthy();
    expect(s.textContent).toBe("Press a key…");
    press(s, "F5");
    expect(screen.getByText("F5 can't be used")).toBeTruthy();
    press(s, "KeyX");
    expect(onChange).toHaveBeenLastCalledWith(B({ fire: ["KeyZ", "KeyX"] }));
  });

  it("key capture ends on a click elsewhere, blur or after 10 s", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Fire", 2);
    fireEvent.click(s);
    fireEvent.mouseDown(screen.getByText("Pixel Peaks"));
    expect(s.textContent).toBe("—");
    fireEvent.click(s);
    fireEvent.blur(s);
    expect(s.textContent).toBe("—");
    fireEvent.click(s);
    act(() => {
      vi.advanceTimersByTime(KEY_CAPTURE_TIMEOUT_MS);
    });
    expect(s.textContent).toBe("—");
    press(s, "KeyX");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a key already in another slot of the action moves to the new slot", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Jump", 1);
    fireEvent.click(s);
    press(s, "ArrowUp");
    expect(onChange).toHaveBeenLastCalledWith(B({ jump: ["ArrowUp"] }));
    expect(slot("Jump", 1).textContent).toBe("↑");
    expect(slot("Jump", 2).textContent).toBe("—");
  });

  it("clears key slots, resets a row and resets all", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Space from Jump" }));
    expect(onChange).toHaveBeenLastCalledWith(B({ jump: ["ArrowUp"] }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Z from Fire" }));
    expect(onChange).toHaveBeenLastCalledWith(B({ jump: ["ArrowUp"], fire: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Jump" }));
    expect(onChange).toHaveBeenLastCalledWith(B({ fire: [] }));
    expect(slot("Jump", 1).textContent).toBe("Space");
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(onChange).toHaveBeenLastCalledWith(B());
    expect(slot("Fire", 1).textContent).toBe("Z");
    expect(screen.queryByText("Changed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
  });

  it("warns about key conflicts (described on the row), never blocking", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Jump", 3);
    fireEvent.click(s);
    press(s, "KeyZ");
    expect(onChange).toHaveBeenLastCalledWith(B({ jump: ["Space", "ArrowUp", "KeyZ"] }));
    const jumpRow = row("Jump");
    const warn = within(jumpRow).getByText("Also used by Fire");
    expect(jumpRow.getAttribute("aria-describedby")).toBe(warn.id);
    expect(within(row("Fire")).getByText("Also used by Jump")).toBeTruthy();
  });

  it("warns once about Ctrl+W/T/N", () => {
    const actions: ControlAction[] = [
      { id: "crouch", name: "Crouch", keys: ["ControlLeft"], gamepad: [] },
      { id: "up", name: "Move up", keys: ["KeyW"], gamepad: [] },
      { id: "talk", name: "Talk", keys: ["KeyT"], gamepad: [] },
    ];
    render(<Harness actions={actions} />);
    expect(screen.getAllByText("Browsers may close or open tabs on Ctrl+W, Ctrl+T or Ctrl+N")).toHaveLength(1);
  });

  it("shows Unbound when an action has no keys and no buttons", () => {
    render(<Harness />);
    expect(screen.queryByText("Unbound")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear Z from Fire" }));
    expect(within(row("Fire")).getByText("Unbound")).toBeTruthy();
    // Gamepad-only actions are bound…
    expect(within(row("Pause")).queryByText("Unbound")).toBeNull();
    // …until all their gamepad buttons are cleared.
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad Start from Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad D-pad ↑ from Pause" }));
    expect(within(row("Pause")).getByText("Unbound")).toBeTruthy();
  });

  it("uses the studio note in studio mode and closes on Done", () => {
    const onClose = vi.fn();
    render(<ControlsPanel mode="studio" title="Draft" actions={ACTIONS} bindings={B()} syncState="failed" onChange={() => {}} onClose={onClose} />);
    expect(screen.getByText("Kept for this Studio session")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("with only a hint, shows the text and no table", () => {
    render(<Harness actions={[]} hint="Drag to aim" />);
    expect(screen.getByText("Drag to aim")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("ControlsPanel gamepad slots (F016)", () => {
  it("capture assigns a pressed button, and the slot shows the prompt meanwhile", () => {
    pads.connect(0);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = pad("Fire", 1);
    fireEvent.click(s);
    expect(s.textContent).toBe("Press a button…");
    expect(s.getAttribute("aria-label")).toBe("Fire, gamepad button 1: press a button");
    expect(screen.getByText("Press a button on your controller for Fire, or Escape to cancel")).toBeTruthy();
    pads.frame();
    pads.press(0, 1);
    pads.frame();
    expect(onChange).toHaveBeenLastCalledWith(B({}, { fire: ["B"] }));
    expect(pad("Fire", 1).textContent).toBe("B");
    expect(within(row("Fire")).getByText("Changed")).toBeTruthy();
    // Polling stopped with the capture.
    expect(pads.pending()).toBe(0);
  });

  it("a button already in the other slot of the action moves to this slot", () => {
    pads.connect(0);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(pad("Pause", 1));
    pads.press(0, 12); // Up
    pads.frame();
    expect(onChange).toHaveBeenLastCalledWith(B({}, { pause: ["Up"] }));
    expect(pad("Pause", 1).textContent).toBe("D-pad ↑");
    expect(pad("Pause", 2).textContent).toBe("—");
  });

  it("clears a gamepad slot", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad A from Jump" }));
    expect(onChange).toHaveBeenLastCalledWith(B({}, { jump: [] }));
    expect(pad("Jump", 1).textContent).toBe("—");
    expect(document.activeElement).toBe(pad("Jump", 1));
  });

  it("Reset and Reset all restore keys and gamepad buttons", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={B({ jump: ["KeyK"], fire: ["KeyX"] }, { jump: ["B"], pause: [] })} />);
    expect(within(row("Pause")).getByText("Changed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset Jump" }));
    expect(onChange).toHaveBeenLastCalledWith(B({ fire: ["KeyX"] }, { pause: [] }));
    expect(pad("Jump", 1).textContent).toBe("A");
    expect(slot("Jump", 1).textContent).toBe("Space");
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(onChange).toHaveBeenLastCalledWith(B());
    expect(pad("Pause", 1).textContent).toBe("Start");
    expect(screen.queryByText("Changed")).toBeNull();
  });

  it("a gamepad-only change marks the row changed and offers Reset", () => {
    render(<Harness initial={B({}, { fire: ["X"] })} />);
    expect(within(row("Fire")).getByText("Changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset Fire" })).toBeTruthy();
  });

  it("warns about a shared gamepad button in one combined list, and announces it", () => {
    pads.connect(0);
    render(<Harness initial={B({ fire: ["Space"] })} />);
    expect(within(row("Fire")).getByText("Also used by Jump")).toBeTruthy();
    fireEvent.click(pad("Fire", 1));
    pads.press(0, 9); // Start, also Pause's
    pads.frame();
    expect(within(row("Fire")).getByText("Also used by Jump, Pause")).toBeTruthy();
    expect(within(row("Pause")).getByText("Also used by Fire")).toBeTruthy();
    expect(document.querySelector(".pf-controls [aria-live='polite'][aria-atomic='true']")!.textContent).toBe("Start is also used by Pause");
  });

  it("only one slot captures at a time (keys and gamepad)", () => {
    pads.connect(0);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(slot("Fire", 2));
    expect(slot("Fire", 2).textContent).toBe("Press a key…");
    fireEvent.click(pad("Fire", 1));
    expect(slot("Fire", 2).textContent).toBe("—");
    expect(pad("Fire", 1).textContent).toBe("Press a button…");
    fireEvent.click(pad("Jump", 2));
    expect(pad("Fire", 1).textContent).toBe("—");
    expect(pad("Jump", 2).textContent).toBe("Press a button…");
    fireEvent.click(slot("Jump", 3));
    expect(pad("Jump", 2).textContent).toBe("—");
    expect(screen.getAllByText(/^Press a (key|button)…$/)).toHaveLength(1);
    expect(pads.pending()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape, blur, a click elsewhere and 10 s end gamepad capture; other keys are ignored", () => {
    vi.useFakeTimers();
    pads.connect(0);
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onChange={onChange} onClose={onClose} />);
    const s = pad("Fire", 1);
    fireEvent.click(s);
    press(s, "KeyK", "k");
    expect(s.textContent).toBe("Press a button…");
    press(s, "Escape");
    expect(s.textContent).toBe("—");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(s);
    fireEvent.blur(s);
    expect(s.textContent).toBe("—");
    fireEvent.click(s);
    fireEvent.mouseDown(screen.getByText("Pixel Peaks"));
    expect(s.textContent).toBe("—");
    fireEvent.click(s);
    act(() => {
      vi.advanceTimersByTime(GAMEPAD_CAPTURE_TIMEOUT_MS);
    });
    expect(s.textContent).toBe("—");
    expect(pads.pending()).toBe(0);
    pads.press(0, 0);
    pads.frame();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the capture messages", () => {
    render(<Harness />);
    const s = pad("Fire", 1);
    fireEvent.click(s);
    // No controller yet.
    expect(screen.getByText("Press any button on your controller. If nothing happens, reconnect it.")).toBeTruthy();
    pads.connect(0, { pressed: [0] }); // wake-up press: ignored
    pads.frame();
    pads.press(0, 16); // Home
    pads.frame();
    expect(screen.getByText("That button can't be used")).toBeTruthy();
    pads.connect(1, { mapping: "" });
    pads.frame();
    pads.press(1, 0);
    pads.frame();
    expect(screen.getByText("This controller isn't supported yet")).toBeTruthy();
    expect(s.textContent).toBe("Press a button…");
  });

  it("ends capture with a message when controllers aren't available", () => {
    pads.uninstall();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = pad("Fire", 1);
    fireEvent.click(s);
    expect(s.textContent).toBe("—");
    expect(screen.getByText("Controllers aren't available on this page")).toBeTruthy();
    // Slots can still be cleared and reset.
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad A from Jump" }));
    expect(onChange).toHaveBeenLastCalledWith(B({}, { jump: [] }));
  });

  it("never shows the controller name", () => {
    pads.connect(0, { id: "Secret Pad (Vendor: 1234 Product: 5678)" });
    render(<Harness />);
    fireEvent.click(pad("Fire", 1));
    pads.press(0, 2);
    pads.frame();
    expect(document.body.textContent).not.toMatch(/Secret|Vendor|1234/);
  });
});

describe("ControlsPanel footer (F016)", () => {
  it("says where bindings are saved for each sync state", () => {
    const { rerender } = render(<Harness syncState="device" />);
    expect(screen.getByText("Saved on this device")).toBeTruthy();
    rerender(<Harness syncState="account" />);
    expect(screen.getByText("Saved to your account")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Harness syncState="failed" />);
    expect(screen.getByRole("status").textContent).toBe("Saved on this device. Couldn't save to your account; it will be retried.");
    expect(screen.getByRole("status").className).toContain("pf-controls__saved--failed");
  });
});
