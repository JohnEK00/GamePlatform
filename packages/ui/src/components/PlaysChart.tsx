import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { DailyPlays } from "../api/types";

/** Rounds up to a "nice" integer axis maximum (tick step 1, 2 or 5 × 10^n) so tick labels are whole numbers. */
export function niceMax(v: number, ticks = 4): number {
  if (!(v > 0)) return ticks;
  const raw = v / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag);
  return step * ticks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export type PlaysChartProps = {
  daily: DailyPlays[];
  /** Accessible title, e.g. "Plays per day, last 30 days" */
  title?: string;
  height?: number;
};

/**
 * Responsive SVG bar chart of daily plays (hand-written, no deps). Hover/focus a day for a tooltip; arrow keys move
 * between days when the chart is focused. A visually hidden table carries the same data for screen readers.
 */
export function PlaysChart({ daily, title = "Plays per day, last 30 days", height = 200 }: PlaysChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const uid = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = daily.length;
  const total = daily.reduce((s, d) => s + d.plays, 0);
  const max = daily.reduce((m, d) => Math.max(m, d.plays), 0);
  const yMax = niceMax(max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f * 100) / 100);

  const m = { top: 12, right: 8, bottom: 26, left: 40 };
  const innerW = Math.max(10, width - m.left - m.right);
  const innerH = Math.max(10, height - m.top - m.bottom);
  const band = n ? innerW / n : innerW;
  const barW = Math.max(2, Math.min(28, band * 0.68));
  const y = (v: number) => m.top + innerH - (v / yMax) * innerH;
  const xCenter = (i: number) => m.left + band * i + band / 2;
  // Label roughly every week, always including the most recent day.
  const labelEvery = width < 420 ? 10 : 7;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => Math.min(n - 1, Math.max(0, (a ?? (d > 0 ? -1 : n)) + d)));
    } else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Escape") setActive(null);
  };

  const cur = active !== null ? daily[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(xCenter(active), 60), width - 60) : 0;
  const summary = `${title}. ${total.toLocaleString()} plays in total; busiest day ${max.toLocaleString()} plays.`;

  return (
    <figure className="pf-chart" aria-labelledby={`${uid}-cap`}>
      <figcaption id={`${uid}-cap`} className="pf-chart__caption">
        <span>{title}</span>
        <span className="pf-muted">{total.toLocaleString()} total</span>
      </figcaption>
      <div
        className="pf-chart__plot"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label={`${summary} Use the arrow keys to read individual days.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          <defs>
            <linearGradient id={`${uid}-bar`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--pf-accent)" />
              <stop offset="1" stopColor="var(--pf-accent-3)" stopOpacity="0.75" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={m.left}
                x2={width - m.right}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "pf-chart__axis" : "pf-chart__grid"}
              />
              <text x={m.left - 8} y={y(t)} className="pf-chart__tick" textAnchor="end" dominantBaseline="middle">
                {t >= 1000 ? `${Math.round(t / 100) / 10}k` : t}
              </text>
            </g>
          ))}
          {daily.map((d, i) => {
            const h = Math.max(d.plays > 0 ? 2 : 0, y(0) - y(d.plays));
            const isActive = active === i;
            return (
              <g key={d.date}>
                <rect
                  x={xCenter(i) - barW / 2}
                  y={y(0) - h}
                  width={barW}
                  height={h}
                  rx={Math.min(3, barW / 3)}
                  fill={`url(#${uid}-bar)`}
                  className={`pf-chart__bar${isActive ? " is-active" : ""}${active !== null && !isActive ? " is-dim" : ""}`}
                />
                {(n - 1 - i) % labelEvery === 0 && (
                  <text x={xCenter(i)} y={height - 8} className="pf-chart__tick" textAnchor="middle">
                    {shortDate(d.date)}
                  </text>
                )}
                {/* full-height hit target */}
                <rect
                  x={m.left + band * i}
                  y={m.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                  onTouchStart={() => setActive(i)}
                >
                  <title>{`${shortDate(d.date)}: ${d.plays} plays`}</title>
                </rect>
              </g>
            );
          })}
          {active !== null && (
            <line x1={xCenter(active)} x2={xCenter(active)} y1={m.top} y2={y(0)} className="pf-chart__cursor" pointerEvents="none" />
          )}
        </svg>
        {cur && (
          <div className="pf-chart__tip" style={{ left: tipLeft, top: Math.max(0, y(cur.plays) - 8) }} role="status">
            <strong>{cur.plays.toLocaleString()}</strong> {cur.plays === 1 ? "play" : "plays"}
            <span>{longDate(cur.date)}</span>
          </div>
        )}
        {total === 0 && <div className="pf-chart__empty">No plays in the last {n || 30} days yet</div>}
      </div>
      <table className="pf-sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Date (UTC)</th>
            <th scope="col">Plays</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{d.plays}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
