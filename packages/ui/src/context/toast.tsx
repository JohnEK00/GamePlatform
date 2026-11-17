import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "info" | "success" | "error";
export type ToastInput = {
  title: string;
  message?: string;
  kind?: ToastKind;
  /** ms; default 4500 (errors 7000). Toasts with an `action` stay at least `TOAST_ACTION_MIN_MS`; the timer pauses while the region is hovered or focused. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Custom icon (e.g. an achievement image) replacing the default kind glyph. */
  icon?: ReactNode;
};
type ToastItem = ToastInput & { id: number };

export type ToastApi = {
  show: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  success: (title: string, message?: string) => number;
  error: (title: string, message?: string) => number;
  info: (title: string, message?: string) => number;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts with an action (e.g. Undo) stay at least this long (review 6, M2). */
export const TOAST_ACTION_MIN_MS = 10_000;
/** After hover / focus leaves the toast region, a toast gets at least this much time back before it closes. */
export const TOAST_RESUME_MIN_MS = 3000;

/** Default lifetime of a toast: errors 7 s, others 4.5 s; toasts with an action at least `TOAST_ACTION_MIN_MS`. */
export function toastDuration(t: ToastInput): number {
  const base = t.duration ?? (t.kind === "error" ? 7000 : 4500);
  return t.action ? Math.max(base, TOAST_ACTION_MIN_MS) : base;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);
  // WCAG 2.2.1: no toast times out while the pointer is over the region or focus is inside it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-4), { ...t, id }]);
    return id;
  }, []);

  // A focused toast that unmounts fires no blur: re-derive both flags whenever the list changes.
  useEffect(() => {
    const region = regionRef.current;
    const a = typeof document !== "undefined" ? document.activeElement : null;
    setFocused(!!region && !!a && region.contains(a));
    if (items.length === 0) setHovered(false);
  }, [items]);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (title, message) => show({ title, message, kind: "success" }),
      error: (title, message) => show({ title, message, kind: "error" }),
      info: (title, message) => show({ title, message, kind: "info" }),
    }),
    [show, dismiss],
  );

  const paused = hovered || focused;
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        ref={regionRef}
        className="pf-toasts"
        role="region"
        aria-label="Status messages"
        aria-live="polite"
        data-paused={paused || undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (!(next instanceof Node && e.currentTarget.contains(next))) setFocused(false);
        }}
      >
        {items.map((t) => (
          <Toast key={t.id} item={t} paused={paused} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, paused, onDismiss }: { item: ToastItem; paused: boolean; onDismiss: () => void }) {
  const kind = item.kind ?? "info";
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const rootRef = useRef<HTMLDivElement>(null);
  /** Where focus was before it entered this toast; restored if the toast closes under focus. */
  const returnTo = useRef<HTMLElement | null>(null);
  const remaining = useRef(toastDuration(item));

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const h = setTimeout(() => dismissRef.current(), remaining.current);
    return () => {
      clearTimeout(h);
      remaining.current = Math.max(TOAST_RESUME_MIN_MS, remaining.current - (Date.now() - started));
    };
  }, [paused]);

  useEffect(() => {
    const root = rootRef.current;
    return () => {
      const a = document.activeElement;
      const lost = !a || a === document.body || (root && root.contains(a));
      const back = returnTo.current;
      if (lost && back && back.isConnected) back.focus();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`pf-toast pf-toast--${kind}`}
      role={kind === "error" ? "alert" : "status"}
      onFocus={(e) => {
        const from = e.relatedTarget;
        if (from instanceof HTMLElement && !e.currentTarget.contains(from)) returnTo.current = from;
      }}
    >
      {item.icon ? (
        <span className="pf-toast__icon pf-toast__icon--custom" aria-hidden="true">
          {item.icon}
        </span>
      ) : (
        <span className="pf-toast__icon" aria-hidden="true">
          {kind === "success" ? "✓" : kind === "error" ? "!" : "i"}
        </span>
      )}
      <div className="pf-toast__body">
        <strong>{item.title}</strong>
        {item.message && <p>{item.message}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          className="pf-btn pf-btn--sm pf-btn--primary"
          onClick={() => {
            item.action!.onClick();
            onDismiss();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="pf-toast__close" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const c = useContext(ToastContext);
  if (!c) throw new Error("useToast must be used inside <WebGameApp> / <WebGameProviders>");
  return c;
}
