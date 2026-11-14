import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, isApiError } from "../api/client";
import { useApi, useConfig, usePlatform } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { ConfirmDialog, Spinner } from "../components/common";
import { errorMessage, formatBytes, useDocumentTitle } from "../util";
import { CodeEditor, type CodeEditorHandle } from "../studio/CodeEditor";
import { StudioPreview, type StudioConsoleEntry } from "../studio/StudioPreview";
import { STUDIO_TEMPLATES } from "../studio/templates";
import { OpenGameDialog } from "../studio/OpenGameDialog";
import { PublishDialog } from "../studio/PublishDialog";
import {
  ACHIEVEMENT_ID_PATTERN,
  asManifest,
  buildBundleZipAsync,
  checkBundleSize,
  downloadBlob,
  MAX_BUNDLE_UNCOMPRESSED_BYTES,
  projectSize,
  resolveProjectFile,
  extOf,
  IMAGE_EXTENSIONS,
  isTextPath,
  LEADERBOARD_LABEL_MAX,
  leaderboardOf,
  loadSessionFromStorage,
  normalizeProjectPath,
  projectFromFileList,
  projectFromZip,
  saveProjectToStorage,
  slugify,
  validateProject,
  withLeaderboard,
  ALLOWED_EXTENSIONS,
  type LocalProject,
  type StudioLink,
  type StudioAchievement,
  type StudioManifest,
  type StudioProject,
} from "../studio/project";

/**
 * Window CustomEvent a host (e.g. a native menu) dispatches to trigger the Studio's
 * "Open folder" flow. See docs/ARCHITECTURE.md "v2 features".
 */
export const STUDIO_OPEN_FOLDER_EVENT = "webgame:studio-open-folder";

declare global {
  interface Window {
    /** Set by a host before the Studio mounts; consumed (and cleared) once on mount. */
    __webgameStudioOpenPending?: boolean;
  }
}

const MANIFEST = "game.json";
const ZIP_ACCEPT = ".zip,application/zip";
const ASSET_ACCEPT = ALLOWED_EXTENSIONS.filter((e) => e !== "json" && e !== "js").map((e) => `.${e}`).join(",");

function templateProject(id: string): StudioProject {
  const t = STUDIO_TEMPLATES.find((x) => x.id === id) ?? STUDIO_TEMPLATES[0];
  return { manifest: structuredCloneSafe(t.manifest), files: { ...t.files } };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type LogItem = StudioConsoleEntry & { id: number; time: number };

// ---------------------------------------------------------------------------------------------

function ManifestForm({ project, onChange }: { project: StudioProject; onChange: (m: StudioManifest) => void }) {
  const m = asManifest(project.manifest);
  const set = (patch: Partial<StudioManifest>) => onChange({ ...m, ...patch });
  const jsFiles = Object.keys(project.files).filter((p) => extOf(p) === "js");
  const images = Object.keys(project.files).filter((p) => IMAGE_EXTENSIONS.includes(extOf(p)));
  const achievements: StudioAchievement[] = Array.isArray(m.achievements) ? m.achievements : [];
  const setAch = (i: number, patch: Partial<StudioAchievement>) =>
    set({ achievements: achievements.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const numVal = (v: unknown) => (typeof v === "number" ? String(v) : "");
  const lb = leaderboardOf(m);
  const rawLbLabel = (m.leaderboard as { label?: unknown } | undefined)?.label;
  const lbLabel = typeof rawLbLabel === "string" ? rawLbLabel : "";

  return (
    <div className="pf-studio-manifest">
      <h2 className="pf-panel__title">game.json</h2>
      <div className="pf-form__row2">
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-st-name">
            Name
          </label>
          <input id="pf-st-name" className="pf-input" value={typeof m.name === "string" ? m.name : ""} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-st-entry">
            Entry
          </label>
          <select id="pf-st-entry" className="pf-input" value={typeof m.entry === "string" ? m.entry : ""} onChange={(e) => set({ entry: e.target.value })}>
            {!jsFiles.includes(String(m.entry ?? "")) && <option value={String(m.entry ?? "")}>{String(m.entry ?? "(none)")}</option>}
            {jsFiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pf-form__row2">
        {(["width", "height"] as const).map((k) => (
          <div className="pf-field" key={k}>
            <label className="pf-label" htmlFor={`pf-st-${k}`}>
              {k === "width" ? "Width" : "Height"} <span className="pf-muted pf-small">(64–4096)</span>
            </label>
            <input
              id={`pf-st-${k}`}
              className="pf-input"
              type="number"
              min={64}
              max={4096}
              step={1}
              value={numVal(m[k])}
              onChange={(e) => set({ [k]: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </div>
        ))}
      </div>

      <fieldset className="pf-studio-lb">
        <legend>Leaderboard</legend>
        <div className="pf-form__row2">
          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-st-lb-order">
              Order
            </label>
            <select
              id="pf-st-lb-order"
              className="pf-input"
              value={lb.order}
              onChange={(e) => onChange(withLeaderboard(m, { order: e.target.value === "asc" ? "asc" : "desc" }))}
            >
              <option value="desc">Higher is better</option>
              <option value="asc">Lower is better</option>
            </select>
          </div>
          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-st-lb-format">
              Format
            </label>
            <select
              id="pf-st-lb-format"
              className="pf-input"
              value={lb.format}
              onChange={(e) => onChange(withLeaderboard(m, { format: e.target.value === "time" ? "time" : "number" }))}
            >
              <option value="number">Number</option>
              <option value="time">Time (milliseconds)</option>
            </select>
          </div>
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-st-lb-label">
            Label <span className="pf-muted pf-small">(optional, max {LEADERBOARD_LABEL_MAX})</span>
          </label>
          <input
            id="pf-st-lb-label"
            className="pf-input"
            maxLength={LEADERBOARD_LABEL_MAX}
            placeholder="Leaderboard"
            value={lbLabel}
            onChange={(e) => onChange(withLeaderboard(m, { label: e.target.value }))}
          />
        </div>
      </fieldset>

      <div className="pf-studio-ach">
        <div className="pf-studio-ach__head">
          <h3>Achievements</h3>
          <button
            type="button"
            className="pf-btn pf-btn--sm"
            disabled={achievements.length >= 50}
            onClick={() => set({ achievements: [...achievements, { id: `achievement_${achievements.length + 1}`, name: "New achievement", description: "" }] })}
          >
            + Add
          </button>
        </div>
        {achievements.length === 0 && (
          <p className="pf-muted pf-small">
            None yet. Unlock them from code with <code>engine.platform.unlockAchievement("id")</code>.
          </p>
        )}
        <ol className="pf-studio-ach__list">
          {achievements.map((a, i) => {
            const idBad = !ACHIEVEMENT_ID_PATTERN.test(a.id ?? "");
            return (
              <li key={i} className="pf-studio-ach__item">
                <div className="pf-form__row2">
                  <div className="pf-field">
                    <label className="pf-label" htmlFor={`pf-ach-id-${i}`}>
                      ID
                    </label>
                    <input
                      id={`pf-ach-id-${i}`}
                      className="pf-input pf-mono"
                      value={a.id ?? ""}
                      maxLength={32}
                      aria-invalid={idBad || undefined}
                      onChange={(e) => setAch(i, { id: e.target.value })}
                    />
                    {idBad && <span className="pf-field__error">a–z, 0–9, _ and -, up to 32 chars</span>}
                  </div>
                  <div className="pf-field">
                    <label className="pf-label" htmlFor={`pf-ach-name-${i}`}>
                      Name
                    </label>
                    <input id={`pf-ach-name-${i}`} className="pf-input" maxLength={60} value={a.name ?? ""} onChange={(e) => setAch(i, { name: e.target.value })} />
                  </div>
                </div>
                <div className="pf-field">
                  <label className="pf-label" htmlFor={`pf-ach-desc-${i}`}>
                    Description
                  </label>
                  <input
                    id={`pf-ach-desc-${i}`}
                    className="pf-input"
                    maxLength={200}
                    value={a.description ?? ""}
                    onChange={(e) => setAch(i, { description: e.target.value })}
                  />
                </div>
                <div className="pf-studio-ach__row">
                  <label className="pf-label" htmlFor={`pf-ach-icon-${i}`}>
                    Icon
                  </label>
                  <select id={`pf-ach-icon-${i}`} className="pf-input" value={a.icon ?? ""} onChange={(e) => setAch(i, { icon: e.target.value || undefined })}>
                    <option value="">(none)</option>
                    {images.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="pf-linkbtn pf-linkbtn--danger"
                    onClick={() => set({ achievements: achievements.filter((_, j) => j !== i) })}
                    aria-label={`Remove achievement ${a.name || a.id}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function AssetView({ path, data }: { path: string; data: string | ArrayBuffer }) {
  const [url, setUrl] = useState<string | null>(null);
  const ext = extOf(path);
  const isImage = IMAGE_EXTENSIONS.includes(ext);
  const isAudio = ["wav", "mp3", "ogg"].includes(ext);
  useEffect(() => {
    if (!isImage && !isAudio) return;
    const type = ext === "svg" ? "image/svg+xml" : isImage ? `image/${ext === "jpg" ? "jpeg" : ext}` : `audio/${ext === "mp3" ? "mpeg" : ext}`;
    const u = URL.createObjectURL(new Blob([data], { type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, ext, isImage, isAudio]);
  const size = typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
  return (
    <div className="pf-studio-asset">
      <p className="pf-muted pf-small">
        {path} · {formatBytes(size)}
      </p>
      {url && isImage && <img src={url} alt={path} />}
      {url && isAudio && <audio src={url} controls />}
      {!isImage && !isAudio && <p className="pf-muted">Binary file — not editable here.</p>}
      <p className="pf-muted pf-small">
        Load it from code with e.g. <code>{isImage ? `engine.assets.loadTexture("${path}")` : isAudio ? `engine.assets.loadSound("${path}")` : `engine.assets.loadBinary("${path}")`}</code>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; title?: string };

/** F013: the "📂 Open ▾" menu button (aria menu pattern: Enter/Space/↓ open, ↑/↓/Home/End move, Escape closes). */
function OpenMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const enabledItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (!open) return;
    enabledItems()[0]?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) btnRef.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = enabledItems();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  };

  return (
    <div
      className="pf-menuwrap"
      ref={wrapRef}
      onBlur={(e) => {
        if (open && e.relatedTarget instanceof Node && !wrapRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className="pf-btn pf-btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        📂 Open <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="pf-menu" role="menu" aria-label="Open" ref={menuRef} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="pf-menu__item"
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                close(true);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type ReplaceRequest = { title: string; body: ReactNode; confirmLabel: string; run: () => void };
type LocalFolder = { id: string; name: string };
type LoadOptions = {
  /** The new link, or "keep" (reload). */
  link: StudioLink | null | "keep";
  /** The desktop folder handle; default: cleared. */
  localFolder?: LocalFolder | null | "keep";
  /** Keep the selected file when it still exists (reload). */
  keepSelected?: boolean;
  /** Console message; default "Opened {source}." */
  message?: string;
};

const REPLACE_BODY = "Your unpublished changes in the Studio will be lost. Export a .zip first to keep them.";

/** Game Studio: edit, run and publish a game in the browser. Usable logged out; publishing needs an account. */
export function StudioPage() {
  useDocumentTitle("Studio");
  const platform = usePlatform();
  const { apiBaseUrl } = useConfig();
  const api = useApi();
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [initial] = useState(() => loadSessionFromStorage());
  const [project, setProject] = useState<StudioProject>(() => initial?.project ?? templateProject("blank"));
  // F013: link + dirty live next to the project (not inside it) and are autosaved with it.
  const [link, setLink] = useState<StudioLink | null>(() => initial?.link ?? null);
  const [dirty, setDirty] = useState<boolean>(() => initial?.dirty ?? false);
  // F013: desktop folder handle, session-scoped: never autosaved.
  const [localFolder, setLocalFolder] = useState<LocalFolder | null>(null);
  const [selected, setSelected] = useState<string>(() => {
    const m = asManifest(project.manifest);
    return typeof m.entry === "string" && m.entry in project.files ? m.entry : MANIFEST;
  });
  const [runId, setRunId] = useState(1);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "too-large">("saved");
  const [replaceReq, setReplaceReq] = useState<ReplaceRequest | null>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [choosingGame, setChoosingGame] = useState(false);
  const [busyText, setBusyText] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<{ file: string; line: number } | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const logId = useRef(0);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const consoleRef = useRef<HTMLOListElement>(null);

  const activeLink = link && link.apiBase === apiBaseUrl ? link : null;
  const manifest = asManifest(project.manifest);
  const problems = useMemo(() => validateProject(project), [project]);
  const size = useMemo(() => projectSize(project), [project]);
  const fileNames = useMemo(() => Object.keys(project.files).sort((a, b) => a.localeCompare(b)), [project.files]);

  const session = useRef({ project, link, dirty, activeLink });
  session.current = { project, link, dirty, activeLink };

  // Autosave (debounced), with the link and dirty flag.
  useEffect(() => {
    setSaveState("saving");
    const t = setTimeout(() => setSaveState(saveProjectToStorage(project, { link, dirty }) ? "saved" : "too-large"), 500);
    return () => clearTimeout(t);
  }, [project, link, dirty]);
  // Flush on unmount (e.g. navigating to the game page right after a publish).
  useEffect(
    () => () => {
      const s = session.current;
      saveProjectToStorage(s.project, { link: s.link, dirty: s.dirty });
    },
    [],
  );

  const log = useCallback((e: StudioConsoleEntry) => {
    // R3: errors carry the bundle-relative `file`; fall back to the entry when it is missing or unknown.
    let entry = e;
    if (e.line) {
      const p = projectRef.current;
      const m = asManifest(p.manifest);
      const fallback = typeof m.entry === "string" ? (resolveProjectFile(p.files, m.entry) ?? m.entry) : undefined;
      const file = resolveProjectFile(p.files, e.file) ?? fallback;
      entry = { ...e, file };
      if (e.level === "error" && file) setErrorLine({ file, line: e.line });
    }
    setLogs((xs) => [...xs.slice(-199), { ...entry, id: ++logId.current, time: Date.now() }]);
  }, []);
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const run = useCallback(() => {
    setLogs([]);
    setErrorLine(null);
    const errs = validateProject(projectRef.current);
    if (errs.length) for (const e of errs) log({ level: "warn", message: e });
    setRunId((n) => n + 1);
  }, [log]);

  /** Every edit to the manifest or files goes through here (marks the project dirty). */
  const editProject = (fn: (p: StudioProject) => StudioProject) => {
    setProject(fn);
    setDirty(true);
  };

  const loadProject = (p: StudioProject, source: string, opts: LoadOptions) => {
    const files = { ...p.files };
    setProject({ manifest: p.manifest, files });
    setDirty(false);
    if (opts.link !== "keep") setLink(opts.link);
    if (opts.localFolder !== "keep") setLocalFolder(opts.localFolder ?? null);
    const m = asManifest(p.manifest);
    const entry = typeof m.entry === "string" && m.entry in files ? m.entry : MANIFEST;
    setSelected((cur) => (opts.keepSelected && (cur === MANIFEST || cur in files) ? cur : entry));
    setLogs([{ level: "info", message: opts.message ?? `Opened ${source}.`, id: ++logId.current, time: Date.now() }]);
    setErrorLine(null);
    setRunId((n) => n + 1);
  };

  /** Runs `run` at once for a clean project, or after the replace confirm when it is dirty. */
  const guardReplace = (runIt: () => void, req: Partial<Omit<ReplaceRequest, "run">> = {}) => {
    if (!session.current.dirty) return runIt();
    setReplaceReq({ title: req.title ?? "Replace the current project?", body: req.body ?? REPLACE_BODY, confirmLabel: req.confirmLabel ?? "Replace", run: runIt });
  };

  const reportSkipped = (skipped: string[]) => {
    if (skipped.length)
      toast.info(`Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"}`, `Unsupported types: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);
  };

  const setFile = (path: string, data: string | ArrayBuffer) => editProject((p) => ({ ...p, files: { ...p.files, [path]: data } }));

  // ---- Open → Local folder ----
  const openFolderNow = async () => {
    if (platform.openLocalProject) {
      try {
        const p: LocalProject | null = await platform.openLocalProject();
        if (p) {
          const lf = p.localFolder && typeof p.localFolder.id === "string" ? { id: p.localFolder.id, name: String(p.localFolder.name ?? "") } : null;
          loadProject({ manifest: p.manifest, files: p.files }, lf ? `“${lf.name}”` : "local folder", { link: null, localFolder: lf });
        }
      } catch (e) {
        toast.error("Couldn't open the folder", typeof e === "string" ? e : errorMessage(e));
      }
      return;
    }
    dirInputRef.current?.click();
  };
  const openFolder = () => guardReplace(() => void openFolderNow());

  const openFolderRef = useRef(openFolder);
  openFolderRef.current = openFolder;
  useEffect(() => {
    const onOpen = () => void openFolderRef.current();
    window.addEventListener(STUDIO_OPEN_FOLDER_EVENT, onOpen);
    if (window.__webgameStudioOpenPending === true) {
      window.__webgameStudioOpenPending = false;
      onOpen();
    }
    return () => window.removeEventListener(STUDIO_OPEN_FOLDER_EVENT, onOpen);
  }, []);

  const onDirPicked = async (files: FileList | null) => {
    if (!files || !files.length) return;
    try {
      const { project: p, skipped } = await projectFromFileList(files);
      loadProject(p, "folder", { link: null });
      reportSkipped(skipped);
    } catch (e) {
      toast.error("Couldn't open the folder", errorMessage(e));
    } finally {
      if (dirInputRef.current) dirInputRef.current.value = "";
    }
  };

  // ---- Open → .zip file ----
  const onZipPicked = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const { project: p, skipped } = await projectFromZip(await file.arrayBuffer());
      loadProject(p, `“${file.name}”`, { link: null });
      reportSkipped(skipped);
    } catch (e) {
      toast.error("Couldn't open the .zip", errorMessage(e));
    } finally {
      if (zipInputRef.current) zipInputRef.current.value = "";
    }
  };
  const openZipNow = async () => {
    if (platform.pickFile) {
      try {
        await onZipPicked(await platform.pickFile(ZIP_ACCEPT));
      } catch (e) {
        toast.error("Couldn't open the .zip", typeof e === "string" ? e : errorMessage(e));
      }
      return;
    }
    zipInputRef.current?.click();
  };
  const openZip = () => guardReplace(() => void openZipNow());

  // ---- Open → My game / ?open= ----
  const openGameError = (e: unknown) => {
    const title = "Couldn't open the game";
    if (isApiError(e)) {
      if (e.code === "unsupported") return void toast.error(title, e.message);
      if (e.status === 403 || e.status === 404) return void toast.error(title, "It may have been deleted, or it isn't yours.");
      if (e.status === 429) return void toast.error(title, e.retryAfter ? `Too many downloads; try again in ${e.retryAfter}s` : "Too many downloads; try again later.");
      if (e.status === 503) return void toast.error(title, "The server is busy; try again in a few seconds.");
    }
    toast.error(title, errorMessage(e));
  };

  /** Downloads a game's current bundle into the Studio. `skipIfVersion`: stop with "Already open" at that version. */
  const downloadGame = async (id: string, skipIfVersion?: number) => {
    setBusyText("Opening the game…");
    try {
      const game = await api.getGame(id);
      if (!game.isOwner) {
        openGameError(new ApiError("forbidden", "Not your game.", 403));
        return;
      }
      if (skipIfVersion !== undefined && game.version === skipIfVersion) {
        setLink((l) => (l && l.gameId === id ? { ...l, title: game.title } : l));
        toast.info("Already open", `${game.title} v${game.version}`);
        return;
      }
      setBusyText(`Downloading ${game.title}…`);
      let res: Awaited<ReturnType<typeof api.downloadBundle>>;
      try {
        res = await api.downloadBundle(id);
      } catch (e) {
        if (!(isApiError(e) && e.status === 409)) throw e;
        res = await api.downloadBundle(id); // the game changed mid-build: retry once
      }
      const { project: p, skipped } = await projectFromZip(await res.blob.arrayBuffer());
      loadProject(p, `“${game.title}” v${res.version}`, { link: { gameId: id, title: game.title, version: res.version, apiBase: apiBaseUrl } });
      reportSkipped(skipped);
    } catch (e) {
      openGameError(e);
    } finally {
      setBusyText(null);
    }
  };

  const requestOpenGame = (id: string) => {
    const { activeLink: l, dirty: d } = session.current;
    if (l && l.gameId === id && !d) return void downloadGame(id, l.version);
    guardReplace(() => void downloadGame(id));
  };
  const requestOpenGameRef = useRef(requestOpenGame);
  requestOpenGameRef.current = requestOpenGame;

  // `/studio?open={id}`: drop the query at once (a page reload must not re-download), then open after auth settles.
  const openParam = searchParams.get("open");
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!openParam) return;
    setPendingOpen(openParam);
    navigate({ search: "" }, { replace: true });
  }, [openParam, navigate]);
  useEffect(() => {
    if (!pendingOpen || authLoading) return;
    const id = pendingOpen;
    setPendingOpen(null);
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(`/studio?open=${encodeURIComponent(id)}`)}`, { replace: true });
      return;
    }
    requestOpenGameRef.current(id);
  }, [pendingOpen, authLoading, user, navigate]);

  // ---- Reload folder (desktop) ----
  const reloadFolderNow = async (lf: LocalFolder) => {
    if (!platform.reloadLocalProject) return;
    try {
      const p = await platform.reloadLocalProject(lf.id);
      if (!p) return;
      const next = p.localFolder && typeof p.localFolder.id === "string" ? { id: p.localFolder.id, name: String(p.localFolder.name ?? lf.name) } : "keep";
      loadProject({ manifest: p.manifest, files: p.files }, lf.name, { link: "keep", localFolder: next, keepSelected: true, message: `Reloaded ${lf.name} from disk.` });
    } catch (e) {
      const msg = typeof e === "string" ? e : errorMessage(e);
      toast.error("Couldn't reload the folder", msg);
      if (/no longer available/i.test(msg)) setLocalFolder((cur) => (cur?.id === lf.id ? null : cur));
    }
  };
  const reloadFolder = () => {
    const lf = localFolder;
    if (!lf) return;
    guardReplace(() => void reloadFolderNow(lf), {
      title: `Discard Studio edits and reload ${lf.name} from disk?`,
      body: `Edits made here since ${lf.name} was loaded will be lost.`,
      confirmLabel: "Reload",
    });
  };

  const importAssets = async (files: FileList | null) => {
    if (!files) return;
    const added: Record<string, string | ArrayBuffer> = {};
    for (const f of Array.from(files)) {
      if (!ALLOWED_EXTENSIONS.includes(extOf(f.name))) {
        toast.error(`"${f.name}" isn't an allowed file type`);
        continue;
      }
      const path = normalizeProjectPath(`assets/${f.name}`)!;
      added[path] = isTextPath(path) ? await f.text() : await f.arrayBuffer();
    }
    if (Object.keys(added).length) {
      editProject((p) => ({ ...p, files: { ...p.files, ...added } }));
      setSelected(Object.keys(added)[0]);
    }
    if (assetInputRef.current) assetInputRef.current.value = "";
  };

  const createFile = (e: FormEvent) => {
    e.preventDefault();
    if (newFile === null) return;
    const path = normalizeProjectPath(newFile.includes(".") ? newFile : `${newFile}.js`);
    if (!path || path === MANIFEST) return toast.error("Invalid file name");
    if (!isTextPath(path) || !ALLOWED_EXTENSIONS.includes(extOf(path))) return toast.error("New files must be .js, .json, .txt, .css or .svg");
    if (path in project.files) return toast.error(`"${path}" already exists`);
    setFile(path, extOf(path) === "json" ? "{}\n" : "");
    setSelected(path);
    setNewFile(null);
  };

  const renameFile = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const to = normalizeProjectPath(renaming.to);
    if (!to || to === MANIFEST || !ALLOWED_EXTENSIONS.includes(extOf(to))) return toast.error("Invalid file name");
    if (to !== renaming.from && to in project.files) return toast.error(`"${to}" already exists`);
    if (to !== renaming.from)
      editProject((p) => {
        const files: StudioProject["files"] = {};
        for (const [k, v] of Object.entries(p.files)) files[k === renaming.from ? to : k] = v;
        const m = asManifest(p.manifest);
        if (m.entry === renaming.from) m.entry = to;
        if (Array.isArray(m.achievements)) m.achievements = m.achievements.map((a) => (a.icon === renaming.from ? { ...a, icon: to } : a));
        return { manifest: m, files };
      });
    if (selected === renaming.from) setSelected(to);
    setRenaming(null);
  };

  const deleteFile = (path: string) => {
    editProject((p) => {
      const files = { ...p.files };
      delete files[path];
      return { ...p, files };
    });
    if (selected === path) setSelected(MANIFEST);
    setConfirmDelete(null);
  };

  const exportZip = async () => {
    let blob: Blob;
    const filename = `${slugify(String(manifest.name ?? "game"))}.zip`;
    try {
      blob = await buildBundleZipAsync(project);
    } catch (e) {
      toast.error("Couldn't build the zip", errorMessage(e));
      return;
    }
    const sizeErr = checkBundleSize(blob);
    if (sizeErr) toast.error("Too large to upload", sizeErr);
    if (platform.saveFile) {
      try {
        if (await platform.saveFile(filename, blob)) toast.success("Saved", filename);
      } catch (e) {
        toast.error("Couldn't save the zip", errorMessage(e));
      }
      return;
    }
    downloadBlob(blob, filename);
  };

  const selectedData = selected === MANIFEST ? null : project.files[selected];

  const jumpTo = (item: LogItem) => {
    if (!item.line) return;
    const target = resolveProjectFile(project.files, item.file) ?? resolveProjectFile(project.files, typeof manifest.entry === "string" ? manifest.entry : null);
    if (target && typeof project.files[target] === "string") {
      setSelected(target);
      setErrorLine(item.level === "error" ? { file: target, line: item.line } : null);
      setTimeout(() => editorRef.current?.goTo(item.line!, item.column ?? 1), 0);
    }
  };

  const openItems: MenuItem[] = [
    { label: "Local folder…", onSelect: openFolder },
    { label: ".zip file…", onSelect: openZip },
    user
      ? { label: "My game…", onSelect: () => setChoosingGame(true) }
      : { label: "My game…", onSelect: () => {}, disabled: true, title: "Log in to open your games" },
  ];

  return (
    <div className="pf-studio">
      <header className="pf-studio__bar">
        <div className="pf-studio__title">
          <h1>Studio</h1>
          <span className="pf-muted pf-small" aria-live="polite">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved in this browser" : "⚠ Too large to autosave"}
          </span>
          {activeLink && (
            <span className="pf-chip pf-studio__link" data-testid="studio-link">
              <span>
                Linked to <Link to={`/games/${encodeURIComponent(activeLink.gameId)}`}>{activeLink.title}</Link> · v{activeLink.version}
              </span>
              <button type="button" className="pf-iconbtn pf-iconbtn--sm pf-studio__unlink" aria-label={`Unlink from ${activeLink.title}`} title="Unlink" onClick={() => setLink(null)}>
                ✕
              </button>
            </span>
          )}
          <span
            className={`pf-small ${size > MAX_BUNDLE_UNCOMPRESSED_BYTES ? "pf-studio__size--over" : "pf-muted"}`}
            title={`Bundle size before compression (limit ${formatBytes(MAX_BUNDLE_UNCOMPRESSED_BYTES)} uncompressed, 50 MB compressed)`}
            data-testid="studio-size"
          >
            {formatBytes(size)} · {Object.keys(project.files).length + 1} files
          </span>
        </div>
        <div className="pf-studio__actions">
          <label className="pf-sr-only" htmlFor="pf-st-template">
            New from template
          </label>
          <select
            id="pf-st-template"
            className="pf-input pf-input--sm"
            value=""
            onChange={(e) => {
              const t = STUDIO_TEMPLATES.find((x) => x.id === e.target.value);
              if (t) guardReplace(() => loadProject(templateProject(t.id), `the “${t.name}” template`, { link: null }));
            }}
          >
            <option value="">New from template…</option>
            {STUDIO_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <OpenMenu items={openItems} />
          {localFolder && platform.reloadLocalProject && (
            <button type="button" className="pf-btn pf-btn--sm" title={`Reload ${localFolder.name} from disk`} onClick={reloadFolder}>
              ↻ Reload folder
            </button>
          )}
          <input
            ref={dirInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => void onDirPicked(e.target.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <input ref={zipInputRef} type="file" hidden accept={ZIP_ACCEPT} data-testid="studio-zip-input" onChange={(e) => void onZipPicked(e.target.files?.[0])} />
          <button type="button" className="pf-btn pf-btn--sm" onClick={exportZip}>
            ⬇ Export .zip
          </button>
          {user ? (
            <button
              type="button"
              className="pf-btn pf-btn--sm pf-btn--primary"
              onClick={() => (problems.length ? toast.error("Fix the project problems first", problems[0]) : setPublishing(true))}
            >
              ⬆ Publish
            </button>
          ) : (
            <Link to="/login?next=%2Fstudio" className="pf-btn pf-btn--sm pf-btn--primary" title="Your project is kept in this browser">
              Log in to publish
            </Link>
          )}
          <button type="button" className="pf-btn pf-btn--sm pf-btn--run" onClick={run} title="Run (Ctrl/Cmd+S)">
            ▶ Run
          </button>
        </div>
      </header>

      <div className="pf-studio__body" aria-busy={busyText !== null || undefined}>
        <aside className="pf-studio__files" aria-label="Project files">
          <div className="pf-studio__files-head">
            <strong>Files</strong>
            <span>
              <button type="button" className="pf-iconbtn pf-iconbtn--sm" title="New file" aria-label="New file" onClick={() => setNewFile("")}>
                ＋
              </button>
              <button type="button" className="pf-iconbtn pf-iconbtn--sm" title="Import images / sounds" aria-label="Import assets" onClick={() => assetInputRef.current?.click()}>
                ⇪
              </button>
            </span>
            <input ref={assetInputRef} type="file" hidden multiple accept={ASSET_ACCEPT} onChange={(e) => void importAssets(e.target.files)} />
          </div>
          {newFile !== null && (
            <form onSubmit={createFile} className="pf-studio__newfile">
              <input
                autoFocus
                className="pf-input pf-input--sm"
                placeholder="player.js"
                aria-label="New file name"
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setNewFile(null)}
              />
            </form>
          )}
          <ul className="pf-studio__filelist">
            <li>
              <button type="button" className={`pf-studio__file${selected === MANIFEST ? " is-active" : ""}`} onClick={() => setSelected(MANIFEST)}>
                <span aria-hidden="true">⚙</span> game.json
              </button>
            </li>
            {fileNames.map((p) => (
              <li key={p}>
                {renaming?.from === p ? (
                  <form onSubmit={renameFile} className="pf-studio__newfile">
                    <input
                      autoFocus
                      className="pf-input pf-input--sm"
                      aria-label={`Rename ${p}`}
                      value={renaming.to}
                      onChange={(e) => setRenaming({ from: p, to: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                      onBlur={() => setRenaming(null)}
                    />
                  </form>
                ) : (
                  <div className={`pf-studio__file${selected === p ? " is-active" : ""}`}>
                    <button type="button" className="pf-studio__file-name" onClick={() => setSelected(p)} title={p}>
                      <span aria-hidden="true">{isTextPath(p) ? (extOf(p) === "js" ? "ƒ" : "≡") : IMAGE_EXTENSIONS.includes(extOf(p)) ? "▣" : "♪"}</span>{" "}
                      {p}
                      {p === manifest.entry && <span className="pf-badge pf-badge--entry">entry</span>}
                    </button>
                    <span className="pf-studio__file-actions">
                      <button type="button" className="pf-iconbtn pf-iconbtn--sm" aria-label={`Rename ${p}`} title="Rename" onClick={() => setRenaming({ from: p, to: p })}>
                        ✎
                      </button>
                      <button type="button" className="pf-iconbtn pf-iconbtn--sm" aria-label={`Delete ${p}`} title="Delete" onClick={() => setConfirmDelete(p)}>
                        ×
                      </button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {localFolder && dirty && (
            <p className="pf-muted pf-small pf-studio__hint">
              Edits made here aren't saved to {localFolder.name}. Export a .zip, or edit the files on disk and reload.
            </p>
          )}
          {problems.length > 0 && (
            <div className="pf-studio__problems" role="status">
              <strong>Problems ({problems.length})</strong>
              <ul>
                {problems.slice(0, 8).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <section className="pf-studio__editor" aria-label="Editor">
          {selected === MANIFEST ? (
            <ManifestForm project={project} onChange={(m) => editProject((p) => ({ ...p, manifest: m }))} />
          ) : selectedData === undefined ? (
            <p className="pf-muted pf-pad">Select a file.</p>
          ) : typeof selectedData === "string" ? (
            <CodeEditor
              ref={editorRef}
              label={`Edit ${selected}`}
              value={selectedData}
              onChange={(v) => setFile(selected, v)}
              onRun={run}
              errorLine={errorLine && errorLine.file === selected ? errorLine.line : undefined}
            />
          ) : (
            <AssetView path={selected} data={selectedData as ArrayBuffer} />
          )}
        </section>

        <section className="pf-studio__run" aria-label="Preview">
          <StudioPreview project={project} runId={runId} onLog={log} />
          <div className="pf-studio__console">
            <div className="pf-studio__console-head">
              <strong>Console</strong>
              <span>
                <button type="button" className="pf-linkbtn" onClick={run}>
                  ↻ Restart
                </button>{" "}
                <button type="button" className="pf-linkbtn" onClick={() => setLogs([])}>
                  Clear
                </button>
              </span>
            </div>
            <ol className="pf-studio__log" ref={consoleRef} aria-live="polite">
              {logs.length === 0 && <li className="pf-muted">Messages from your game appear here. Press F3 in the preview for the debug overlay.</li>}
              {logs.map((l) => (
                <li key={l.id} className={`pf-log pf-log--${l.level}`}>
                  {l.line ? (
                    <button
                      type="button"
                      className="pf-log__loc"
                      onClick={() => jumpTo(l)}
                      title={`Go to ${l.file ? `${l.file} ` : ""}line ${l.line}`}
                      aria-label={`Go to ${l.file ? `${l.file} ` : ""}line ${l.line}${l.column ? `, column ${l.column}` : ""}`}
                    >
                      {l.file ? `${l.file}:` : ""}
                      {l.line}
                      {l.column ? `:${l.column}` : ""}
                    </button>
                  ) : null}
                  <span>{l.message}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
        {busyText !== null && (
          <div className="pf-studio__overlay" role="status" aria-live="polite">
            <Spinner size={28} label={busyText} />
            <span>{busyText}</span>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={replaceReq !== null}
        title={replaceReq?.title ?? ""}
        confirmLabel={replaceReq?.confirmLabel ?? "Replace"}
        danger
        onCancel={() => setReplaceReq(null)}
        onConfirm={() => {
          const r = replaceReq;
          setReplaceReq(null);
          r?.run();
        }}
      >
        {replaceReq?.body}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete ?? ""}?`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteFile(confirmDelete)}
      />
      {publishing && (
        <PublishDialog
          project={project}
          link={activeLink}
          apiBase={apiBaseUrl}
          onClose={() => setPublishing(false)}
          onPublished={(l) => {
            setLink(l);
            setDirty(false);
            saveProjectToStorage(project, { link: l, dirty: false });
          }}
          onUnlink={() => setLink(null)}
          onLinkTitle={(title) => setLink((l) => (l ? { ...l, title } : l))}
        />
      )}
      {choosingGame && (
        <OpenGameDialog
          onClose={() => setChoosingGame(false)}
          onPick={(g) => {
            setChoosingGame(false);
            requestOpenGame(g.id);
          }}
        />
      )}
    </div>
  );
}
