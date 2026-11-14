import { useId } from "react";
import { RELEASE_NOTES_MAX } from "../util";

/** The live counter appears once the notes reach this many characters. */
const COUNTER_FROM = 900;

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
  const length = Array.from(value).length;
  const showCounter = length >= COUNTER_FROM;
  const describedBy = [showCounter ? `${uid}-count` : null, error ? `${uid}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`pf-field pf-notesfield${className ? ` ${className}` : ""}`}>
      <label htmlFor={id} className={hideLabel ? "pf-sr-only" : "pf-label"}>
        {label}
      </label>
      <textarea
        id={id}
        className="pf-input pf-notesfield__input"
        rows={rows}
        maxLength={RELEASE_NOTES_MAX}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
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
