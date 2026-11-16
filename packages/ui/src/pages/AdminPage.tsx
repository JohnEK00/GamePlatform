import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { commentPermalink } from "../api/comments";
import { useResolveUrl } from "../context/config";
import type { Report, ReportAction, ReportStatus } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { ConfirmDialog, EmptyState, ErrorState, Pagination, Skeleton, UserLink } from "../components/common";
import { REPORT_REASONS } from "../components/Report";
import { TabPanel, Tabs } from "../components/Tabs";
import { errorMessage, formatDate, timeAgo, useAsync, useDocumentTitle } from "../util";

const PER_PAGE = 25;
const STATUS_TABS_ID = "pf-admin-status";

const ACTION_COPY: Record<ReportAction, { label: string; title: (r: Report) => string; body: (r: Report) => string; danger: boolean }> = {
  dismiss: {
    label: "Dismiss",
    title: () => "Dismiss this report?",
    body: () => "The content stays up. All open reports on the same target are resolved as dismissed.",
    danger: false,
  },
  unpublish: {
    label: "Unpublish",
    title: (r) => `Unpublish “${r.targetPreview}”?`,
    body: () => "The game is hidden from everyone but its owner, who can fix and republish it.",
    danger: true,
  },
  delete: {
    label: "Delete",
    title: (r) =>
      r.targetType === "game"
        ? `Delete “${r.targetPreview}”?`
        : r.targetType === "screenshot"
          ? "Delete this screenshot?"
          : r.targetType === "collection"
            ? "Delete this collection?"
            : "Delete this comment?",
    body: (r) =>
      r.targetType === "game"
        ? "The game, its files, ratings, comments and scores are removed permanently."
        : r.targetType === "screenshot"
          ? "The screenshot and its files are removed permanently."
          : r.targetType === "collection"
            ? "The games stay on the site; only this list is removed."
            : "The comment is removed permanently, together with any replies to it.",
    danger: true,
  },
};

const KNOWN_TARGET_TYPES: ReadonlySet<string> = new Set(["game", "comment", "screenshot", "collection"]);

/** Moderation actions per target type; unknown (newer) types get Dismiss only. */
export function reportActions(targetType: string): ReportAction[] {
  if (targetType === "game") return ["dismiss", "unpublish", "delete"];
  if (KNOWN_TARGET_TYPES.has(targetType)) return ["dismiss", "delete"];
  return ["dismiss"];
}

function gameLink(gameId: string | null | undefined): string | null {
  return gameId ? `/games/${encodeURIComponent(gameId)}` : null;
}

function reasonLabel(r: Report["reason"]): string {
  return REPORT_REASONS.find((x) => x.value === r)?.label ?? r;
}

function ReportRow({ report, onResolved }: { report: Report; onResolved: (r: Report) => void }) {
  const api = useApi();
  const toast = useToast();
  const [confirm, setConfirm] = useState<ReportAction | null>(null);
  const [busy, setBusy] = useState(false);
  const resolveUrl = useResolveUrl();
  // Unpublish only makes sense for games; comments, (F005) screenshots and (F008) collections get Dismiss / Delete.
  const actions = reportActions(report.targetType);
  const gamePath = gameLink(report.targetGameId);

  const run = async (action: ReportAction) => {
    setBusy(true);
    try {
      const r = await api.resolveReport(report.id, action);
      toast.success(`Report resolved: ${action}`, report.targetPreview.slice(0, 80));
      setConfirm(null);
      onResolved(r);
    } catch (e) {
      toast.error("Couldn't resolve report", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = confirm ? ACTION_COPY[confirm] : null;
  return (
    <li className="pf-report-row">
      <div className="pf-report-row__head">
        <span className={`pf-badge pf-badge--${report.targetType}`}>{report.targetType}</span>
        <span className={`pf-badge pf-badge--reason pf-badge--reason-${report.reason}`}>{reasonLabel(report.reason)}</span>
        <time className="pf-muted pf-small" dateTime={report.createdAt} title={formatDate(report.createdAt)}>
          {timeAgo(report.createdAt)}
        </time>
        <span className="pf-muted pf-small pf-report-row__by">
          by <UserLink user={report.reporter} size={18} />
        </span>
      </div>
      <div className="pf-report-row__target">
        {report.targetType === "game" ? (
          gamePath ? (
            <Link to={gamePath} className="pf-report-row__title">
              {report.targetPreview}
            </Link>
          ) : (
            <strong className="pf-report-row__title">{report.targetPreview}</strong>
          )
        ) : report.targetType === "collection" ? (
          <>
            <strong className="pf-report-row__title pf-report-row__title--text">{report.targetPreview}</strong>{" "}
            <Link to={`/c/${encodeURIComponent(report.targetId)}`} className="pf-small">
              View collection →
            </Link>
          </>
        ) : report.targetType === "screenshot" ? (
          <div className="pf-report-row__shot">
            {report.targetImageUrl ? (
              <a href={resolveUrl(report.targetImageFullUrl ?? report.targetImageUrl) ?? undefined} target="_blank" rel="noopener" className="pf-report-row__thumb" title="Open full size">
                <img src={resolveUrl(report.targetImageUrl) ?? undefined} alt={`Reported screenshot: ${report.targetPreview}`} width={120} />
              </a>
            ) : (
              <span className="pf-report-row__thumb pf-report-row__thumb--gone pf-muted pf-small">(deleted)</span>
            )}
            <div>
              <blockquote className="pf-report-row__quote">{report.targetPreview}</blockquote>
              {gamePath && (
                <Link to={gamePath} className="pf-small">
                  View the game →
                </Link>
              )}
            </div>
          </div>
        ) : report.targetType === "comment" ? (
          <>
            <blockquote className="pf-report-row__quote">{report.targetPreview}</blockquote>
            {/* F006: the permalink opens the game page with the comment (or reply) highlighted and focused. */}
            {report.targetGameId && (
              <Link to={commentPermalink(report.targetGameId, report.targetId)} className="pf-small">
                View in context →
              </Link>
            )}
          </>
        ) : (
          <blockquote className="pf-report-row__quote">{report.targetPreview}</blockquote>
        )}
      </div>
      {report.details && <p className="pf-report-row__details">“{report.details}”</p>}
      {report.status === "open" ? (
        <div className="pf-report-row__actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={`pf-btn pf-btn--sm ${ACTION_COPY[a].danger ? "pf-btn--danger" : "pf-btn--ghost"}`}
              onClick={() => setConfirm(a)}
              disabled={busy}
            >
              {ACTION_COPY[a].label}
            </button>
          ))}
        </div>
      ) : (
        <p className="pf-muted pf-small">
          Resolved{report.resolution ? ` · ${report.resolution}` : ""}
          {report.resolvedAt ? ` · ${formatDate(report.resolvedAt)}` : ""}
        </p>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={copy && confirm ? copy.title(report) : ""}
        confirmLabel={copy?.label ?? "Confirm"}
        danger={copy?.danger}
        busy={busy}
        onConfirm={() => confirm && void run(confirm)}
        onCancel={() => setConfirm(null)}
      >
        {copy?.body(report)}
      </ConfirmDialog>
    </li>
  );
}

/** Moderation queue (role admin). */
export function AdminPage() {
  const api = useApi();
  const { user } = useAuth();
  useDocumentTitle("Moderation");
  const [params, setParams] = useSearchParams();
  const status: ReportStatus = params.get("status") === "resolved" ? "resolved" : "open";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const isAdmin = user?.role === "admin";
  const { data, loading, error, reload, setData } = useAsync(
    () => (isAdmin ? api.listReports({ status, page, perPage: PER_PAGE }) : Promise.resolve(null)),
    [api, status, page, isAdmin],
  );

  if (!isAdmin)
    return (
      <div className="pf-container pf-page">
        <EmptyState icon="🔒" title="Admins only">
          You need the admin role to see the moderation queue.
        </EmptyState>
      </div>
    );

  const setStatus = (s: ReportStatus) => setParams(s === "open" ? new URLSearchParams() : new URLSearchParams({ status: s }));

  return (
    <div className="pf-container pf-page">
      <header className="pf-pagehead pf-pagehead--row">
        <div>
          <h1>Moderation</h1>
          <p className="pf-muted">Review reported games, comments, screenshots and collections.</p>
        </div>
      </header>
      <Tabs
        id={STATUS_TABS_ID}
        label="Report status"
        value={status}
        onChange={setStatus}
        items={(["open", "resolved"] as const).map((s) => ({
          value: s,
          label: (
            <>
              {s === "open" ? "Open" : "Resolved"}
              {status === s && data ? <span className="pf-tab__count">{data.total}</span> : null}
            </>
          ),
        }))}
      />

      <TabPanel id={STATUS_TABS_ID} value={status}>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <ul className="pf-report-list">
          {[0, 1, 2].map((i) => (
            <li key={i} className="pf-report-row">
              <Skeleton height={64} />
            </li>
          ))}
        </ul>
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon="✓" title={status === "open" ? "Inbox zero" : "Nothing resolved yet"}>
          {status === "open" ? "No open reports. Nice." : "Resolved reports will show up here."}
        </EmptyState>
      ) : (
        <ul className="pf-report-list">
          {data.items.map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              onResolved={(res) =>
                // Resolving one report resolves every open report on the same target.
                setData((d) => {
                  if (!d) return d as never;
                  const removed = d.items.filter((x) => x.targetType === res.targetType && x.targetId === res.targetId).length;
                  return {
                    ...d,
                    items: d.items.filter((x) => !(x.targetType === res.targetType && x.targetId === res.targetId)),
                    total: Math.max(0, d.total - removed),
                  };
                })
              }
            />
          ))}
        </ul>
      )}
      {data && !error && (
        <Pagination
          page={page}
          total={data.total}
          perPage={data.perPage || PER_PAGE}
          onPage={(p) => {
            const next = new URLSearchParams(params);
            if (p === 1) next.delete("page");
            else next.set("page", String(p));
            setParams(next);
          }}
        />
      )}
      </TabPanel>
    </div>
  );
}
