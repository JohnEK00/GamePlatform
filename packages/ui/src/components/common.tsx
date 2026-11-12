import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { UserRef } from "../api/types";
import { useResolveUrl } from "../context/config";
import { errorMessage, hashString } from "../util";

export function Spinner({ size = 20, label = "Loading" }: { size?: number; label?: string }) {
  return <span className="pf-spinner" style={{ width: size, height: size }} role="status" aria-label={label} />;
}

export function Skeleton({ width, height = 16, radius, className = "" }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return <span className={`pf-skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function EmptyState({ icon = "◇", title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pf-empty">
      <div className="pf-empty__icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="pf-empty__action">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="⚠"
      title="Something went wrong"
      action={
        onRetry && (
          <button type="button" className="pf-btn" onClick={onRetry}>
            Try again
          </button>
        )
      }
    >
      {errorMessage(error)}
    </EmptyState>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success"; children: ReactNode }) {
  return (
    <div className={`pf-alert pf-alert--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Deterministic pixel-art cover generated from a seed (used when a game has no thumbnail). */
export function FallbackArt({ seed, label }: { seed: string; label?: string }) {
  const h = hashString(seed);
  const hue = h % 360;
  const hue2 = (hue + 40 + ((h >> 9) % 120)) % 360;
  const cells: ReactNode[] = [];
  // 8x5 mirrored "invader"-style sprite
  let bits = h ^ 0x5bd1e995;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 4; x++) {
      bits = Math.imul(bits ^ (bits >>> 13), 0x5bd1e995) >>> 0;
      if (bits & 1) {
        cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />);
        cells.push(<rect key={`m${x}-${y}`} x={7 - x} y={y} width="1" height="1" />);
      }
    }
  }
  const id = `pf-g${h.toString(36)}`;
  return (
    <svg className="pf-fallback-art" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" role="img" aria-label={label ?? "Game cover"}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 70% 22%)`} />
          <stop offset="1" stopColor={`hsl(${hue2} 75% 12%)`} />
        </linearGradient>
        <pattern id={`${id}p`} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M8 0H0V8" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="160" height="90" fill={`url(#${id})`} />
      <rect width="160" height="90" fill={`url(#${id}p)`} />
      <g transform="translate(56 21) scale(6)" fill={`hsl(${hue2} 90% 68%)`} shapeRendering="crispEdges">
        {cells}
      </g>
      <rect x="0" y="80" width="160" height="10" fill="rgba(0,0,0,0.25)" />
    </svg>
  );
}

export function Thumbnail({ src, seed, alt }: { src: string | null; seed: string; alt: string }) {
  const resolve = useResolveUrl();
  const url = resolve(src);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (imgRef.current) imgRef.current.hidden = false;
  }, [url]);
  return (
    <div className="pf-thumb">
      <FallbackArt seed={seed} label={alt} />
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
    </div>
  );
}

export function Avatar({ user, size = 32 }: { user: Pick<UserRef, "username" | "displayName" | "avatarUrl">; size?: number }) {
  const resolve = useResolveUrl();
  const url = resolve(user.avatarUrl);
  const name = user.displayName || user.username;
  const hue = hashString(user.username) % 360;
  return (
    <span
      className="pf-avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 35%)` }}
      aria-hidden={url ? undefined : "true"}
    >
      {url ? <img src={url} alt="" /> : (name[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function UserLink({ user, size = 24 }: { user: UserRef; size?: number }) {
  return (
    <Link to={`/u/${encodeURIComponent(user.username)}`} className="pf-userlink">
      <Avatar user={user} size={size} />
      <span>{user.displayName || user.username}</span>
    </Link>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="pf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label ?? "Upload progress"}>
      <div className="pf-progress__bar" style={{ width: `${pct}%` }} />
      <span className="pf-progress__label">{label ? `${label} · ` : ""}{pct}%</span>
    </div>
  );
}

export function TagChip({ tag, active, to, onClick }: { tag: string; active?: boolean; to?: string; onClick?: () => void }) {
  const cls = `pf-chip${active ? " pf-chip--active" : ""}`;
  if (to)
    return (
      <Link to={to} className={cls} aria-current={active ? "true" : undefined}>
        #{tag}
      </Link>
    );
  return (
    <button type="button" className={cls} onClick={onClick} aria-pressed={active}>
      #{tag}
    </button>
  );
}

export function Pagination({ page, total, perPage, onPage }: { page: number; total: number; perPage: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  if (pages <= 1) return null;
  const nums: (number | "…")[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <nav className="pf-pagination" aria-label="Pagination">
      <button type="button" className="pf-btn pf-btn--ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      {nums.map((n, i) =>
        n === "…" ? (
          <span key={`e${i}`} className="pf-pagination__gap">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            className={`pf-btn pf-btn--ghost pf-pagination__num${n === page ? " is-current" : ""}`}
            aria-current={n === page ? "page" : undefined}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ),
      )}
      <button type="button" className="pf-btn pf-btn--ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </nav>
  );
}

/** In-page confirmation dialog (window.confirm is unavailable in some webviews). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="pf-modal" role="dialog" aria-modal="true" aria-labelledby="pf-confirm-title" ref={ref}>
        <h2 id="pf-confirm-title">{title}</h2>
        {children && <div className="pf-modal__body">{children}</div>}
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button type="button" className={`pf-btn ${danger ? "pf-btn--danger" : "pf-btn--primary"}`} onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner size={14} /> : null} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StarsDisplay({ value, count }: { value: number; count?: number }) {
  const pct = Math.max(0, Math.min(5, value)) * 20;
  return (
    <span className="pf-stars-display" title={`${value.toFixed(1)} / 5`}>
      <span className="pf-stars-display__track" aria-hidden="true">
        ★★★★★
        <span className="pf-stars-display__fill" style={{ width: `${pct}%` }}>
          ★★★★★
        </span>
      </span>
      <span className="pf-sr-only">{`Rated ${value.toFixed(1)} out of 5`}</span>
      {count !== undefined && <span className="pf-muted">({count})</span>}
    </span>
  );
}
