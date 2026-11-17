import { useEffect, useId, useRef, useState } from "react";
import type { GamepadButtonName } from "../api/types";
import { gamepadLabel } from "../controls";
import { startGamepadCapture, type GamepadCaptureMessage } from "../gamepadCapture";
import { claimCapture } from "./captureSlot";

/** How long gamepad capture waits for a button before giving up (F016 § 2.2). */
export const GAMEPAD_CAPTURE_TIMEOUT_MS = 10_000;

type Notice = GamepadCaptureMessage | "unavailable";

const NOTICES: Record<Notice, string> = {
  "no-controller": "Press any button on your controller. If nothing happens, reconnect it.",
  "unusable-button": "That button can't be used",
  "unsupported-controller": "This controller isn't supported yet",
  unavailable: "Controllers aren't available on this page",
};

export type GamepadCaptureButtonProps = {
  /** The bound button in this slot, or null when empty. */
  button: GamepadButtonName | null;
  /** The action's display name (for accessible names and the capture prompt). */
  actionName: string;
  /** 0-based slot index (for the accessible name). */
  slot: number;
  /** A standard-mapping button was pressed in capture mode. */
  onAssign: (name: GamepadButtonName) => void;
  /** Shows the × "Clear" button on a filled slot. */
  onClear?: () => void;
  disabled?: boolean;
  /** Extra `aria-describedby` id(s) for the slot button (e.g. the row's conflict warning). */
  describedBy?: string;
};

/**
 * One gamepad slot (F016 § 2.2). Click to capture: the parent polls the Gamepad API once per frame (only while
 * capturing) and assigns the first standard-mapping button pressed after capture started. Escape, blur, a click
 * elsewhere or 10 s end capture without a change; other keyboard keys are ignored. Controller names are never shown.
 */
export function GamepadCaptureButton({ button, actionName, slot, onAssign, onClear, disabled, describedBy }: GamepadCaptureButtonProps) {
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const latest = useRef({ onAssign });
  latest.current = { onAssign };

  useEffect(() => {
    if (!capturing) return;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      setCapturing(false);
    };
    const stop = () => {
      end();
      setNotice(null);
    };
    const release = claimCapture(stop);
    const cancel = startGamepadCapture({
      onButton: (name) => {
        stop();
        latest.current.onAssign(name);
      },
      onMessage: (kind) => setNotice(kind),
      onUnavailable: () => {
        // Capture ends, the message stays until the slot loses focus or capture starts again.
        end();
        setNotice("unavailable");
      },
    });
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" || e.code === "Escape") stop();
    };
    const onPointer = (e: MouseEvent) => {
      const btn = btnRef.current;
      if (btn && e.target instanceof Node && btn.contains(e.target)) return;
      stop();
    };
    const timer = setTimeout(stop, GAMEPAD_CAPTURE_TIMEOUT_MS);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      ended = true;
      release();
      cancel();
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointer, true);
    };
  }, [capturing]);

  useEffect(() => {
    if (disabled) setCapturing(false);
  }, [disabled]);

  const label = button ? gamepadLabel(button) : null;
  const name = `${actionName}, gamepad button ${slot + 1}: ${capturing ? "press a button" : (label ?? "none")}`;
  const showNotice = notice !== null && (capturing || notice === "unavailable");
  const describedByIds = [capturing || showNotice ? `${uid}-live` : null, describedBy || null].filter(Boolean).join(" ") || undefined;

  return (
    <span className={`pf-keycap pf-keycap--pad${capturing ? " is-capturing" : ""}${button ? " is-filled" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="pf-keycap__btn"
        aria-label={name}
        aria-describedby={describedByIds}
        disabled={disabled}
        onClick={() => {
          setNotice(null);
          setCapturing((c) => !c);
        }}
        onBlur={() => {
          setCapturing(false);
          setNotice(null);
        }}
      >
        {capturing ? "Press a button…" : (label ?? "—")}
      </button>
      {button && onClear && !capturing && (
        <button
          type="button"
          className="pf-keycap__clear"
          aria-label={`Clear gamepad ${label} from ${actionName}`}
          title="Clear"
          disabled={disabled}
          onClick={() => {
            // The × unmounts once the slot is empty: keep focus on this slot's button.
            btnRef.current?.focus();
            onClear();
          }}
        >
          ×
        </button>
      )}
      <span id={`${uid}-live`} className={showNotice ? "pf-keycap__msg" : "pf-sr-only"} aria-live="polite">
        {showNotice ? NOTICES[notice!] : capturing ? `Press a button on your controller for ${actionName}, or Escape to cancel` : ""}
      </span>
    </span>
  );
}
