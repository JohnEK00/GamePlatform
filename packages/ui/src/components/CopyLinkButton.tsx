import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LINK_COPIED_MS } from "../share";

export type CopyLinkButtonProps = {
  /** The absolute URL to copy (see `appShareUrl` / `profileShareUrl`). */
  url: string;
  /** Idle button text. */
  label?: string;
  className?: string;
  /**
   * Where the fallback field ("Copy this link") is rendered when the clipboard is unavailable. Defaults to right
   * after the button; pass an element (e.g. a slot after an actions row) to render it there instead.
   */
  fallbackContainer?: HTMLElement | null;
};

/**
 * F028: "🔗 Copy link". Writes `url` to the clipboard; shows "Link copied" for {@link LINK_COPIED_MS} and announces it
 * politely. Without a clipboard (or on a rejected write) it shows a read-only, focused and selected field instead.
 */
export function CopyLinkButton({ url, label = "Copy link", className = "pf-btn pf-btn--ghost pf-btn--sm", fallbackContainer }: CopyLinkButtonProps) {
  const uid = useId();
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [live, setLive] = useState({ n: 0, text: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped on every failure so a repeated failure re-focuses the field.
  const [failures, setFailures] = useState(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!failures) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [failures]);

  // A different URL (another profile) resets the button.
  useEffect(() => {
    clearTimeout(timer.current);
    setCopied(false);
    setFallback(null);
  }, [url]);

  const copy = async () => {
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (!clip || typeof clip.writeText !== "function") throw new Error("Clipboard unavailable");
      await clip.writeText(url);
      setFallback(null);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), LINK_COPIED_MS);
      setLive((l) => ({ n: l.n + 1, text: "Link copied" }));
    } catch {
      clearTimeout(timer.current);
      setCopied(false);
      setFallback(url);
      setFailures((n) => n + 1);
    }
  };

  const field = fallback ? (
    <div className="pf-field pf-copylink__fallback">
      <label className="pf-label pf-small" htmlFor={`${uid}-share`}>
        Copy this link
      </label>
      <input ref={inputRef} id={`${uid}-share`} className="pf-input pf-input--sm" readOnly value={fallback} onFocus={(e) => e.currentTarget.select()} />
    </div>
  ) : null;

  return (
    <>
      <button type="button" className={className} onClick={() => void copy()}>
        <span aria-hidden="true">🔗</span> {copied ? "Link copied" : label}
      </button>
      <span className="pf-sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={live.n}>{live.text}</span>
      </span>
      {field && (fallbackContainer ? createPortal(field, fallbackContainer) : field)}
    </>
  );
}
