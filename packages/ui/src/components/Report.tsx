import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import type { ReportReason, ReportTargetType } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Alert, Spinner } from "./common";

export const REPORT_REASONS: { value: ReportReason; label: string; hint: string }[] = [
  { value: "spam", label: "Spam", hint: "Ads, scams or repeated junk" },
  { value: "offensive", label: "Offensive", hint: "Hateful, harassing or explicit content" },
  { value: "broken", label: "Broken", hint: "Doesn't load or is unplayable" },
  { value: "copyright", label: "Copyright", hint: "Uses someone else's work without permission" },
  { value: "other", label: "Other", hint: "Something else — tell us below" },
];

export type ReportDialogProps = {
  open: boolean;
  targetType: ReportTargetType;
  targetId: string;
  /** e.g. the game title, shown in the heading */
  targetLabel?: string;
  onClose: () => void;
};

/** Modal form: reason + optional details → POST /api/reports. */
export function ReportDialog({ open, targetType, targetId, targetLabel, onClose }: ReportDialogProps) {
  const api = useApi();
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const uid = useId();

  useEffect(() => {
    if (!open) return;
    setReason("spam");
    setDetails("");
    setError(null);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input[type=radio]")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason === "other" && !details.trim()) {
      setError("Please describe the problem.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createReport({ targetType, targetId, reason, details: details.trim() || undefined });
      toast.success("Report sent", "Thanks — a moderator will take a look.");
      onClose();
    } catch (err) {
      if (isApiError(err) && err.code === "conflict") {
        toast.info("Already reported", "You already have an open report on this.");
        onClose();
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const what = targetType === "game" ? "game" : "comment";
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="pf-modal pf-report" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref} onSubmit={submit}>
        <h2 id={`${uid}-title`}>
          Report {what}
          {targetLabel ? <span className="pf-muted">: {targetLabel}</span> : null}
        </h2>
        <fieldset className="pf-report__reasons">
          <legend className="pf-label">Reason</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r.value} className={`pf-report__reason${reason === r.value ? " is-active" : ""}`}>
              <input type="radio" name={`${uid}-reason`} value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
              <span>
                <strong>{r.label}</strong>
                <span className="pf-muted pf-small">{r.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="pf-field">
          <label className="pf-label" htmlFor={`${uid}-details`}>
            Details {reason === "other" ? <span className="pf-req">*</span> : <span className="pf-muted pf-small">(optional)</span>}
          </label>
          <textarea
            id={`${uid}-details`}
            className="pf-input"
            rows={3}
            maxLength={1000}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Anything that helps a moderator understand the problem"
          />
          <span className="pf-field__hint">{details.length}/1000</span>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="pf-btn pf-btn--danger" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} Send report
          </button>
        </div>
      </form>
    </div>
  );
}

/** "Report" link-button that opens the ReportDialog (prompts to log in when anonymous). */
export function ReportButton({
  targetType,
  targetId,
  targetLabel,
  className = "pf-linkbtn",
  children = "Report",
}: {
  targetType: ReportTargetType;
  targetId: string;
  targetLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          if (!user) {
            toast.show({
              kind: "info",
              title: "Log in to report content",
              action: { label: "Log in", onClick: () => navigate(`/login?next=${encodeURIComponent(location.pathname)}`) },
            });
            return;
          }
          setOpen(true);
        }}
        aria-haspopup="dialog"
      >
        {children}
      </button>
      <ReportDialog open={open} targetType={targetType} targetId={targetId} targetLabel={targetLabel} onClose={() => setOpen(false)} />
    </>
  );
}
