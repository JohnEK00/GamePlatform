import { useState } from "react";
import type { CommentSettings } from "../api/types";
import { CommentSettingsForm } from "./CommentSettingsForm";
import { useModal } from "./useModal";

export type CommentSettingsDialogProps = {
  open: boolean;
  gameId: string;
  value: CommentSettings;
  onClose: () => void;
  /** The stored values; the caller closes the dialog. */
  onSaved: (next: CommentSettings) => void;
};

/** F020 § 2.3: the game page's "Comment settings" dialog (owner or admin). Focus returns to `#comment-settings-btn`. */
export function CommentSettingsDialog({ open, gameId, value, onClose, onSaved }: CommentSettingsDialogProps) {
  const [saving, setSaving] = useState(false);
  const ref = useModal<HTMLDivElement>(open, onClose, {
    canClose: !saving,
    returnFocus: () => document.getElementById("comment-settings-btn"),
  });
  if (!open) return null;
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="pf-modal pf-modal--wide" role="dialog" aria-modal="true" aria-labelledby="pf-comment-settings-title" ref={ref}>
        <h2 id="pf-comment-settings-title">Comment settings</h2>
        <CommentSettingsForm
          gameId={gameId}
          value={value}
          headingId="pf-comment-settings-title"
          onCancel={onClose}
          onBusyChange={setSaving}
          onSaved={(next) => {
            setSaving(false);
            onSaved(next);
          }}
        />
      </div>
    </div>
  );
}
