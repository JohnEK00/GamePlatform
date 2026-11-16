import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import type { UserRef } from "../api/types";
import { Alert, Avatar, Spinner } from "./common";

export const COMMENT_MAX_LENGTH = 2000;

const SUBMIT_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "") ? "⌘+Enter" : "Ctrl+Enter";

export type CommentFormProps = {
  /** id of the textarea (the label points at it). */
  inputId: string;
  /** id of the <form> (e.g. `reply-form-{threadId}`, the Reply buttons' `aria-controls`). */
  formId?: string;
  /** Accessible name of the form (replies), e.g. "Reply to Mia". */
  formLabel?: string;
  /** Visually hidden textarea label. */
  label: string;
  placeholder?: string;
  submitLabel: string;
  value: string;
  onChange: (value: string) => void;
  /** Receives the trimmed body. */
  onSubmit: (body: string) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  /** Shown next to the form (top-level form). */
  user?: Pick<UserRef, "username" | "displayName" | "avatarUrl"> | null;
  /** Reply forms: Cancel button and Escape in the textarea. */
  onCancel?: () => void;
  /** Reply forms opened from a reply: "Replying to @{username}" with a ✕ that calls `onClearReplyingTo`. */
  replyingTo?: Pick<UserRef, "username"> | null;
  onClearReplyingTo?: () => void;
  /** Focus the textarea on mount (reply forms). */
  autoFocus?: boolean;
  className?: string;
  /** F017: a hint above the textarea (e.g. the locked-thread note for moderators); it also describes the textarea. */
  notice?: string | null;
};

/**
 * Shared top-level / reply comment form (F006 spec § 2.2): 2000-character counter, Ctrl/Cmd+Enter submits,
 * Escape or Cancel closes reply forms. Not a modal: Tab moves in and out freely.
 */
export function CommentForm({
  inputId,
  formId,
  formLabel,
  label,
  placeholder,
  submitLabel,
  value,
  onChange,
  onSubmit,
  busy = false,
  error,
  user,
  onCancel,
  replyingTo,
  onClearReplyingTo,
  autoFocus = false,
  className = "",
  notice = null,
}: CommentFormProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      /* not supported */
    }
  }, [autoFocus]);

  const send = () => {
    const text = value.trim();
    if (!text || busy || text.length > COMMENT_MAX_LENGTH) return;
    void onSubmit(text);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      send();
      return;
    }
    if (e.key === "Escape" && onCancel && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const hintId = `${inputId}-hint`;
  const noticeId = `${inputId}-notice`;
  return (
    <form
      id={formId}
      className={`pf-comment-form ${className}`.trim()}
      onSubmit={submit}
      aria-label={formLabel}
      aria-busy={busy || undefined}
    >
      {user && <Avatar user={user} size={32} />}
      <div className="pf-comment-form__main">
        {replyingTo && (
          <p className="pf-comment-form__replyto pf-small">
            <span>
              Replying to <strong>@{replyingTo.username}</strong>
            </span>
            {onClearReplyingTo && (
              <button
                type="button"
                className="pf-comment-form__clear"
                onClick={() => {
                  onClearReplyingTo();
                  ref.current?.focus();
                }}
                aria-label={`Stop replying to @${replyingTo.username}`}
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </p>
        )}
        {notice && (
          <p className="pf-comment-form__notice pf-small" id={noticeId}>
            <span aria-hidden="true">🔒</span> {notice}
          </p>
        )}
        <label htmlFor={inputId} className="pf-sr-only">
          {label}
        </label>
        <textarea
          ref={ref}
          id={inputId}
          className="pf-input"
          rows={3}
          maxLength={COMMENT_MAX_LENGTH}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={notice ? `${noticeId} ${hintId}` : hintId}
        />
        {error && <Alert>{error}</Alert>}
        <div className="pf-comment-form__actions">
          <span className="pf-muted pf-small" id={hintId}>
            <span>
              {value.length}/{COMMENT_MAX_LENGTH}
            </span>
            <span className="pf-comment-form__kbd"> · {SUBMIT_SHORTCUT} to post</span>
          </span>
          <span className="pf-comment-form__buttons">
            {onCancel && (
              <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="submit" className={`pf-btn pf-btn--primary${onCancel ? " pf-btn--sm" : ""}`} disabled={busy || !value.trim()}>
              {busy ? <Spinner size={14} /> : null} {submitLabel}
            </button>
          </span>
        </div>
      </div>
    </form>
  );
}
