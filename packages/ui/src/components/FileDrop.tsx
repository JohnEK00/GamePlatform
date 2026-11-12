import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { usePlatform } from "../context/config";
import { formatBytes } from "../util";

export type FileDropProps = {
  label: string;
  hint?: string;
  /** <input accept> string, e.g. ".zip,application/zip" */
  accept: string;
  file: File | null;
  onFile: (f: File | null) => void;
  /** Show an image preview of the selected file. */
  preview?: boolean;
  disabled?: boolean;
  icon?: string;
};

function matchesAccept(file: File, accept: string): boolean {
  const parts = accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return parts.some((p) => (p.startsWith(".") ? name.endsWith(p) : p.endsWith("/*") ? type.startsWith(p.slice(0, -1)) : type === p));
}

/** Drag-and-drop file field. Uses `platform.pickFile` (e.g. a native dialog) when provided. */
export function FileDrop({ label, hint, accept, file, onFile, preview, disabled, icon = "⬆" }: FileDropProps) {
  const platform = usePlatform();
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!preview || !file || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, preview]);

  const accept1 = (f: File | null | undefined) => {
    if (!f) return;
    if (!matchesAccept(f, accept)) {
      setError(`"${f.name}" is not an accepted file type (${accept}).`);
      return;
    }
    setError(null);
    onFile(f);
  };

  const browse = async () => {
    if (disabled) return;
    if (platform.pickFile) {
      try {
        accept1(await platform.pickFile(accept));
      } catch {
        setError("Could not open the file picker.");
      }
    } else inputRef.current?.click();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    accept1(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="pf-field">
      <span className="pf-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className={`pf-drop${over ? " is-over" : ""}${file ? " has-file" : ""}${disabled ? " is-disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        aria-disabled={disabled || undefined}
        onClick={browse}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void browse();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {url ? <img className="pf-drop__preview" src={url} alt="" /> : <span className="pf-drop__icon" aria-hidden="true">{icon}</span>}
        <div className="pf-drop__text">
          {file ? (
            <>
              <strong>{file.name}</strong>
              <span className="pf-muted pf-small">{formatBytes(file.size)} · click or drop to replace</span>
            </>
          ) : (
            <>
              <strong>Drop a file here or click to browse</strong>
              <span className="pf-muted pf-small" id={`${id}-hint`}>
                {hint}
              </span>
            </>
          )}
        </div>
        {file && !disabled && (
          <button
            type="button"
            className="pf-iconbtn pf-drop__clear"
            aria-label={`Remove ${file.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            ×
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          accept1(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && (
        <span className="pf-field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
