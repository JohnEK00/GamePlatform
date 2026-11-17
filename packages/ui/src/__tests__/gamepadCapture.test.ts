import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGamepadCapture, STANDARD_GAMEPAD_BUTTONS } from "../gamepadCapture";
import { installFakeGamepads, type FakeGamepads } from "./fakeGamepads";

let pads: FakeGamepads;
beforeEach(() => {
  pads = installFakeGamepads();
});
afterEach(() => {
  pads.uninstall();
});

function start() {
  const onButton = vi.fn();
  const onMessage = vi.fn();
  const onUnavailable = vi.fn();
  const stop = startGamepadCapture({ onButton, onMessage, onUnavailable });
  return { onButton, onMessage, onUnavailable, stop };
}

describe("startGamepadCapture (F016)", () => {
  it("maps standard indices 0–15 to the gamepad table", () => {
    expect(STANDARD_GAMEPAD_BUTTONS).toEqual(["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right"]);
  });

  it("assigns the first button that goes from released to pressed, then stops polling", () => {
    pads.connect(0);
    const c = start();
    expect(c.onMessage).not.toHaveBeenCalled();
    pads.frame();
    expect(c.onButton).not.toHaveBeenCalled();
    pads.press(0, 3);
    pads.frame();
    expect(c.onButton).toHaveBeenCalledWith("Y");
    expect(c.onButton).toHaveBeenCalledTimes(1);
    expect(pads.pending()).toBe(0);
    const n = pads.calls();
    pads.press(0, 0);
    pads.frame();
    expect(pads.calls()).toBe(n);
  });

  it("ignores a button held when capture starts until it is released and pressed again", () => {
    pads.connect(0, { pressed: [0] });
    const c = start();
    pads.frame();
    pads.frame();
    expect(c.onButton).not.toHaveBeenCalled();
    pads.release(0, 0);
    pads.frame();
    expect(c.onButton).not.toHaveBeenCalled();
    pads.press(0, 0);
    pads.frame();
    expect(c.onButton).toHaveBeenCalledWith("A");
  });

  it("treats the first sighting of a controller as a wake-up: held buttons are baseline", () => {
    const c = start();
    expect(c.onMessage).toHaveBeenCalledWith("no-controller");
    pads.frame();
    pads.connect(1, { pressed: [1] });
    pads.frame();
    pads.frame();
    expect(c.onButton).not.toHaveBeenCalled();
    pads.release(1, 1);
    pads.frame();
    pads.press(1, 1);
    pads.frame();
    expect(c.onButton).toHaveBeenCalledWith("B");
  });

  it("a controller that reconnects is seen anew", () => {
    pads.connect(0);
    const c = start();
    pads.frame();
    pads.disconnect(0);
    pads.frame();
    pads.connect(0, { pressed: [2] });
    pads.frame();
    expect(c.onButton).not.toHaveBeenCalled();
  });

  it("reports Home and index 17 as unusable and keeps capturing", () => {
    pads.connect(0);
    const c = start();
    pads.press(0, 16);
    pads.frame();
    expect(c.onMessage).toHaveBeenLastCalledWith("unusable-button");
    pads.release(0, 16);
    pads.frame();
    // Index 17 (some pads have extra buttons): the fake has 17 buttons, so feed one more by hand.
    const stop2 = startGamepadCapture({
      onButton: c.onButton,
      onMessage: c.onMessage,
      onUnavailable: c.onUnavailable,
      getGamepads: (() => {
        let pressed = false;
        return () => {
          const buttons = Array.from({ length: 18 }, (_, i) => ({ pressed: pressed && i === 17 }));
          pressed = true;
          return [{ index: 0, id: "x", mapping: "standard", connected: true, buttons }];
        };
      })(),
    });
    c.onMessage.mockClear();
    pads.frame();
    expect(c.onMessage).toHaveBeenCalledWith("unusable-button");
    expect(c.onMessage).toHaveBeenCalledTimes(1); // the second capture's index 17; the first one saw nothing new
    expect(c.onButton).not.toHaveBeenCalled();
    pads.press(0, 5);
    pads.frame();
    expect(c.onButton).toHaveBeenCalledWith("RB");
    stop2();
  });

  it("reports presses on a non-standard controller and keeps capturing", () => {
    pads.connect(0, { mapping: "" });
    pads.connect(1);
    const c = start();
    pads.press(0, 0);
    pads.frame();
    expect(c.onMessage).toHaveBeenCalledWith("unsupported-controller");
    expect(c.onButton).not.toHaveBeenCalled();
    expect(pads.pending()).toBe(1);
    pads.press(1, 9);
    pads.frame();
    expect(c.onButton).toHaveBeenCalledWith("Start");
  });

  it("a missing or throwing Gamepad API → unavailable, without polling", () => {
    pads.failWith(new DOMException("blocked", "SecurityError"));
    const c = start();
    expect(c.onUnavailable).toHaveBeenCalledTimes(1);
    expect(pads.pending()).toBe(0);

    pads.uninstall();
    pads = installFakeGamepads();
    pads.uninstall(); // navigator.getGamepads is gone
    const d = start();
    expect(d.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("a getGamepads that starts throwing mid-capture ends it as unavailable", () => {
    pads.connect(0);
    const c = start();
    pads.failWith(new Error("gone"));
    pads.frame();
    expect(c.onUnavailable).toHaveBeenCalledTimes(1);
    expect(pads.pending()).toBe(0);
  });

  it("cancel stops polling and nothing fires afterwards", () => {
    pads.connect(0);
    const c = start();
    pads.frame();
    c.stop();
    expect(pads.pending()).toBe(0);
    const n = pads.calls();
    pads.press(0, 0);
    pads.frame();
    expect(pads.calls()).toBe(n);
    expect(c.onButton).not.toHaveBeenCalled();
    c.stop(); // idempotent
  });

  it("never passes the controller id to callbacks", () => {
    pads.connect(0, { id: "Vendor 045e Product 02fd" });
    const c = start();
    pads.press(0, 0);
    pads.frame();
    expect(JSON.stringify([c.onButton.mock.calls, c.onMessage.mock.calls])).not.toMatch(/045e|Vendor/);
  });
});
