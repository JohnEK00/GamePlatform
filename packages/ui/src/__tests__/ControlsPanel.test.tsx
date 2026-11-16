import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlAction } from "../api/types";
import { ControlsPanel } from "../components/ControlsPanel";
import { KEY_CAPTURE_TIMEOUT_MS } from "../components/KeyCaptureButton";
import type { ControlOverrides } from "../controls";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
  { id: "pause", name: "Pause", keys: [], gamepad: ["Start", "Up"] },
];

function Harness({ actions = ACTIONS, initial = {}, onChange, onClose = () => {}, hint }: { actions?: ControlAction[]; initial?: ControlOverrides; onChange?: (o: ControlOverrides) => void; onClose?: () => void; hint?: string }) {
  const [o, setO] = useState<ControlOverrides>(initial);
  return (
    <ControlsPanel
      mode="player"
      title="Pixel Peaks"
      hint={hint}
      actions={actions}
      overrides={o}
      onChange={(n) => {
        onChange?.(n);
        setO(n);
      }}
      onClose={onClose}
    />
  );
}

const slot = (action: string, n: number) => screen.getByRole("button", { name: new RegExp(`^${action}, key ${n}: `) });
const row = (action: string) => screen.getByRole("rowheader", { name: new RegExp(`^${action}`) }).closest("tr") as HTMLTableRowElement;

function press(target: Element, code: string, key = code) {
  fireEvent.keyDown(target, { code, key });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ControlsPanel", () => {
  it("shows the hint, the rows in manifest order and a read-only gamepad column", () => {
    render(<Harness hint="Arrows move, Space jumps" />);
    expect(screen.getByRole("dialog", { name: "Controls" })).toBeTruthy();
    expect(screen.getByText("Pixel Peaks")).toBeTruthy();
    expect(screen.getByText("Arrows move, Space jumps")).toBeTruthy();
    const names = screen.getAllByRole("rowheader").map((th) => th.querySelector("span")!.textContent);
    expect(names).toEqual(["Jump", "Fire", "Pause"]);
    expect(slot("Jump", 1).textContent).toBe("Space");
    expect(slot("Jump", 2).textContent).toBe("↑");
    expect(slot("Jump", 3).textContent).toBe("—");
    const cells = (a: string) => row(a).querySelectorAll("td");
    expect(cells("Jump")[1].textContent).toBe("A");
    expect(cells("Fire")[1].textContent).toBe("—");
    expect(cells("Pause")[1].textContent).toBe("Start, D-pad ↑");
    // The gamepad column has no controls.
    for (const a of ["Jump", "Fire", "Pause"]) expect(within(cells(a)[1] as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(within(cells("Pause")[1] as HTMLElement).queryAllByRole("combobox")).toHaveLength(0);
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
    expect(onChange).toHaveBeenLastCalledWith({ jump: ["Space", "ArrowUp", "KeyK"] });
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
    // Outside capture, Escape closes the dialog (useModal).
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
    expect(onChange).toHaveBeenLastCalledWith({ fire: ["KeyZ", "KeyX"] });
  });

  it("capture ends on a click elsewhere, blur or after 10 s", () => {
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
    expect(onChange).toHaveBeenLastCalledWith({ jump: ["ArrowUp"] });
    expect(slot("Jump", 1).textContent).toBe("↑");
    expect(slot("Jump", 2).textContent).toBe("—");
  });

  it("clears a slot, resets a row and resets all", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Space from Jump" }));
    expect(onChange).toHaveBeenLastCalledWith({ jump: ["ArrowUp"] });
    fireEvent.click(screen.getByRole("button", { name: "Clear Z from Fire" }));
    expect(onChange).toHaveBeenLastCalledWith({ jump: ["ArrowUp"], fire: [] });
    fireEvent.click(screen.getByRole("button", { name: "Reset Jump" }));
    expect(onChange).toHaveBeenLastCalledWith({ fire: [] });
    expect(slot("Jump", 1).textContent).toBe("Space");
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(slot("Fire", 1).textContent).toBe("Z");
    expect(screen.queryByText("Changed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
  });

  it("warns about conflicts (described on the row), never blocking", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const s = slot("Jump", 3);
    fireEvent.click(s);
    press(s, "KeyZ");
    expect(onChange).toHaveBeenLastCalledWith({ jump: ["Space", "ArrowUp", "KeyZ"] });
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
    // Gamepad-only actions are bound.
    expect(within(row("Pause")).queryByText("Unbound")).toBeNull();
  });

  it("uses the studio note in studio mode and closes on Done", () => {
    const onClose = vi.fn();
    render(<ControlsPanel mode="studio" title="Draft" actions={ACTIONS} overrides={{}} onChange={() => {}} onClose={onClose} />);
    expect(screen.getByText("Kept for this Studio session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("with only a hint, shows the text and no table", () => {
    render(<Harness actions={[]} hint="Drag to aim" />);
    expect(screen.getByText("Drag to aim")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
