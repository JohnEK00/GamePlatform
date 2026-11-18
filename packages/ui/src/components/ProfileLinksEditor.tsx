import { useEffect, useId, useImperativeHandle, useRef, type Ref } from "react";
import type { ProfileLink } from "../api/types";
import {
  PROFILE_LINK_LABEL_MAX,
  PROFILE_LINK_URL_MAX,
  PROFILE_LINKS_MAX,
  trimLinkLabel,
  validateProfileLinkLabel,
  validateProfileLinkUrl,
} from "../profile";

/** One editable row (untrimmed, as typed). */
export type ProfileLinkRow = ProfileLink;

/** A row whose label and URL are both empty after trim (dropped on save). */
export function isEmptyLinkRow(row: ProfileLinkRow): boolean {
  return !trimLinkLabel(row.label) && !row.url.trim();
}

/** Per row: null when the row is empty (dropped on save) or its URL is valid; else the inline URL message. */
export function linkRowErrors(rows: readonly ProfileLinkRow[]): (string | null)[] {
  return rows.map((r) => (isEmptyLinkRow(r) ? null : validateProfileLinkUrl(r.url)));
}

/**
 * Per row: null when the row is empty or its label is acceptable; else the server's label message. The index in the
 * message is the row's 0-based position among the rows that are sent (empty rows are dropped first).
 */
export function linkLabelErrors(rows: readonly ProfileLinkRow[]): (string | null)[] {
  let sent = 0;
  return rows.map((r) => (isEmptyLinkRow(r) ? null : validateProfileLinkLabel(r.label, sent++)));
}

/** The `links` body for PATCH /api/users/me: empty rows dropped, values trimmed. */
export function linksForSave(rows: readonly ProfileLinkRow[]): ProfileLink[] {
  return rows.filter((r) => !isEmptyLinkRow(r)).map((r) => ({ label: trimLinkLabel(r.label), url: r.url.trim() }));
}

export type ProfileLinksEditorHandle = {
  /** Focuses row `index`'s URL input (e.g. the first invalid one after a failed save). */
  focusUrl: (index: number) => void;
  /** Focuses row `index`'s label input. */
  focusLabel: (index: number) => void;
};

export type ProfileLinksEditorProps = {
  value: ProfileLinkRow[];
  onChange: (rows: ProfileLinkRow[]) => void;
  /** Per-row URL errors (see {@link linkRowErrors}); missing entries mean no error. */
  errors?: readonly (string | null)[];
  /** Per-row label errors (see {@link linkLabelErrors}); missing entries mean no error. */
  labelErrors?: readonly (string | null)[];
  disabled?: boolean;
  ref?: Ref<ProfileLinksEditorHandle>;
};

type PendingFocus = { kind: "label"; index: number } | { kind: "remove"; index: number } | { kind: "add" };

/**
 * F028 Settings links fieldset (controlled): up to 3 rows of label + URL + Remove, and "+ Add link". Add focuses the
 * new row's label; Remove focuses the same index's label, else the previous row's Remove, else "+ Add link".
 */
export function ProfileLinksEditor({ value, onChange, errors, labelErrors, disabled, ref }: ProfileLinksEditorProps) {
  const uid = useId();
  const labels = useRef<(HTMLInputElement | null)[]>([]);
  const urls = useRef<(HTMLInputElement | null)[]>([]);
  const removes = useRef<(HTMLButtonElement | null)[]>([]);
  const addRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<PendingFocus | null>(null);

  useImperativeHandle(
    ref,
    () => ({ focusUrl: (i: number) => urls.current[i]?.focus(), focusLabel: (i: number) => labels.current[i]?.focus() }),
    [],
  );

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (p.kind === "label") labels.current[p.index]?.focus();
    else if (p.kind === "remove") removes.current[p.index]?.focus();
    else addRef.current?.focus();
  }, [value]);

  const update = (i: number, patch: Partial<ProfileLinkRow>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const add = () => {
    if (value.length >= PROFILE_LINKS_MAX) return;
    pending.current = { kind: "label", index: value.length };
    onChange([...value, { label: "", url: "" }]);
  };

  const remove = (i: number) => {
    const next = value.filter((_, j) => j !== i);
    pending.current = i < next.length ? { kind: "label", index: i } : i > 0 ? { kind: "remove", index: i - 1 } : { kind: "add" };
    onChange(next);
  };

  return (
    <fieldset className="pf-field pf-links-editor" disabled={disabled}>
      <legend className="pf-label">Links</legend>
      <p className="pf-field__hint pf-links-editor__hint">Up to 3 links, shown on your profile.</p>
      {value.length > 0 && (
        <ul className="pf-links-editor__rows">
          {value.map((row, i) => {
            const n = i + 1;
            const error = errors?.[i] ?? null;
            const errId = `${uid}-err-${i}`;
            const labelError = labelErrors?.[i] ?? null;
            const labelErrId = `${uid}-labelerr-${i}`;
            return (
              <li key={i} className="pf-links-editor__row">
                <input
                  ref={(el) => {
                    labels.current[i] = el;
                  }}
                  className="pf-input pf-links-editor__label"
                  aria-label={`Link ${n} label`}
                  placeholder="Label (optional)"
                  maxLength={PROFILE_LINK_LABEL_MAX}
                  value={row.label}
                  aria-invalid={labelError ? "true" : undefined}
                  aria-describedby={labelError ? labelErrId : undefined}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
                <input
                  ref={(el) => {
                    urls.current[i] = el;
                  }}
                  className="pf-input pf-links-editor__url"
                  type="url"
                  inputMode="url"
                  aria-label={`Link ${n} URL`}
                  placeholder="https://…"
                  maxLength={PROFILE_LINK_URL_MAX}
                  value={row.url}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? errId : undefined}
                  onChange={(e) => update(i, { url: e.target.value })}
                />
                <button
                  ref={(el) => {
                    removes.current[i] = el;
                  }}
                  type="button"
                  className="pf-btn pf-btn--ghost pf-btn--sm pf-links-editor__remove"
                  aria-label={`Remove link ${n}`}
                  onClick={() => remove(i)}
                >
                  Remove
                </button>
                {labelError && (
                  <p className="pf-field__error pf-links-editor__error" id={labelErrId}>
                    {labelError}
                  </p>
                )}
                {error && (
                  <p className="pf-field__error pf-links-editor__error" id={errId}>
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {value.length < PROFILE_LINKS_MAX && (
        <div>
          <button ref={addRef} type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={add}>
            + Add link
          </button>
        </div>
      )}
    </fieldset>
  );
}
