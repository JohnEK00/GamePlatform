import { useEffect, useId, useRef, useState } from "react";
import { isBindableKeyboardCode, keyLabel } from "../controls";

/** How long capture mode waits for a key before giving up (F009 § 2.2). */
export const KEY_CAPTURE_TIMEOUT_MS = 10_000;

export type KeyCaptureButtonProps = {
  /** The bound code in this slot, or null when empty. */
  code: string | null;
  /** The action's display name (for accessible names and the capture prompt). */
  actionName: string;
  /** 0-based slot index (for the accessible name). */
  slot: number;
  /** A bindable keyboard code was pressed in capture mode. */
  onAssign: (code: string) => void;
  /** Shows the × "Clear" button on a filled slot. */
  onClear?: () => void;
  /** Layout map for labels (parent UI only). */
  layout?: ReadonlyMap<string, string> | null;
  disabled?: boolean;
  /** Marks the slot as invalid (e.g. a non-bindable code in a hand-written game.json). */
  invalid?: boolean;
};

/**
 * One key slot. Click to enter capture mode; the next bindable `keydown` (captured on `window`, before anything else
 * sees it) is assigned. Escape cancels; a non-bindable key keeps capture mode and says so; blur, a click elsewhere
 * or 10 s end capture without a change. Mouse buttons can't be captured.
 */
export function KeyCaptureButton({ code, actionName, slot, onAssign, onClear, layout, disabled, invalid }: KeyCaptureButtonProps) {
  const [capturing, setCapturing] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  // Listeners read the latest props when they fire (never a render's closure).
  const latest = useRef({ onAssign, layout });
  latest.current = { onAssign, layout };

  useEffect(() => {
    if (!capturing) return;
    setRejected(null);
    const stop = () => {
      setCapturing(false);
      setRejected(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const c = e.code || e.key;
      if (c === "Escape" || e.key === "Escape") return stop();
      if (isBindableKeyboardCode(c)) {
        stop();
        latest.current.onAssign(c);
        return;
      }
      setRejected(`${keyLabel(c, latest.current.layout)} can't be used`);
    };
    const onPointer = (e: MouseEvent) => {
      const btn = btnRef.current;
      if (btn && e.target instanceof Node && btn.contains(e.target)) return;
      stop();
    };
    const timer = setTimeout(stop, KEY_CAPTURE_TIMEOUT_MS);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointer, true);
    };
  }, [capturing]);

  useEffect(() => {
    if (disabled) setCapturing(false);
  }, [disabled]);

  const label = code ? keyLabel(code, layout) : null;
  const name = `${actionName}, key ${slot + 1}: ${capturing ? "press a key" : (label ?? "none")}`;

  return (
    <span className={`pf-keycap${capturing ? " is-capturing" : ""}${code ? " is-filled" : ""}${invalid ? " is-invalid" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="pf-keycap__btn"
        aria-label={name}
        aria-describedby={capturing ? `${uid}-live` : undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setCapturing((c) => !c)}
        onBlur={() => setCapturing(false)}
      >
        {capturing ? "Press a key…" : (label ?? "—")}
      </button>
      {code && onClear && !capturing && (
        <button type="button" className="pf-keycap__clear" aria-label={`Clear ${label} from ${actionName}`} title="Clear" disabled={disabled} onClick={onClear}>
          ×
        </button>
      )}
      <span id={`${uid}-live`} className={capturing && rejected ? "pf-keycap__msg" : "pf-sr-only"} aria-live="polite">
        {capturing ? (rejected ?? `Press a key for ${actionName}, or Escape to cancel`) : ""}
      </span>
    </span>
  );
}
