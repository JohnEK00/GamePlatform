import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "info" | "success" | "error";
export type ToastInput = {
  title: string;
  message?: string;
  kind?: ToastKind;
  /** ms; default 4500 (errors 7000) */
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-4), { ...t, id }]);
    return id;
  }, []);

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

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pf-toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const kind = item.kind ?? "info";
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const ms = item.duration ?? (kind === "error" ? 7000 : 4500);
    const h = setTimeout(() => dismissRef.current(), ms);
    return () => clearTimeout(h);
  }, [item.id, item.duration, kind]);
  return (
    <div className={`pf-toast pf-toast--${kind}`} role={kind === "error" ? "alert" : "status"}>
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
