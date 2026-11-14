import { useId, useLayoutEffect, useRef } from "react";
import { RELEASE_NOTES_MAX } from "../util";

/** The live counter appears once the notes reach this many characters. */
const COUNTER_FROM = 900;

/**
 * N8: applies an edit `prev` → `next` while keeping the text within `max` Unicode code points (what the
 * server counts), like a code-point-aware `maxLength`: the inserted run is cut so the result fits;
 * deletions are always accepted. Returns the new value and where the caret should go (UTF-16 index).
 */
export function clampNotesEdit(prev: string, next: string, max: number): { value: string; caret: number | null } {
  const b = Array.from(next);
  if (b.length <= max) return { value: next, caret: null };
  const a = Array.from(prev);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const inserted = b.slice(p, b.length - s);
  const room = Math.max(0, max - (p + s));
  const head = b.slice(0, p).join("") + inserted.slice(0, room).join("");
  return { value: head + b.slice(b.length - s).join(""), caret: head.length };
}

export type ReleaseNotesFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Default: "What's new in this version (optional)". */
  label?: string;
  /** Shown under the textarea (e.g. a 422 message from the server). */
  error?: string | null;
  disabled?: boolean;
  /** Default 4. */
  rows?: number;
  autoFocus?: boolean;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  className?: string;
};

/** F004: the shared plain-text release-notes textarea (label, 1000-char limit, live counter, error slot). */
export function ReleaseNotesField({
  value,
  onChange,
  label = "What's new in this version (optional)",
  error,
  disabled,
  rows = 4,
  autoFocus,
  hideLabel,
  className,
}: ReleaseNotesFieldProps) {
  const uid = useId();
  const id = `${uid}-notes`;
  // Counted in Unicode code points, like the server (UTF-16 `maxLength` would cut emoji-heavy notes early).
  const length = Array.from(value).length;
  const showCounter = length >= COUNTER_FROM;
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (c === null) return;
    pendingCaret.current = null;
    const el = ref.current;
    if (el && document.activeElement === el) el.setSelectionRange(c, c);
  });
  const describedBy = [showCounter ? `${uid}-count` : null, error ? `${uid}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`pf-field pf-notesfield${className ? ` ${className}` : ""}`}>
      <label htmlFor={id} className={hideLabel ? "pf-sr-only" : "pf-label"}>
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        className="pf-input pf-notesfield__input"
        rows={rows}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const r = clampNotesEdit(value, e.target.value, RELEASE_NOTES_MAX);
          if (r.caret !== null) {
            if (r.value === value) {
              // Nothing fits: React won't re-render, so restore the DOM value and caret here.
              e.target.value = value;
              e.target.setSelectionRange(r.caret, r.caret);
              return;
            }
            pendingCaret.current = r.caret;
          }
          onChange(r.value);
        }}
      />
      {showCounter && (
        <span id={`${uid}-count`} className="pf-field__hint pf-notesfield__count" aria-live="polite">
          {length}/{RELEASE_NOTES_MAX}
        </span>
      )}
      {error && (
        <span id={`${uid}-error`} className="pf-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
