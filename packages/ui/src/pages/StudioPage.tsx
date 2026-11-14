import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi, usePlatform } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { Alert, ConfirmDialog, ProgressBar, Spinner } from "../components/common";
import { useModal } from "../components/useModal";
import { GameFields, type GameFieldValues } from "../components/GameFields";
import { errorMessage, formatBytes, parseTags, useDocumentTitle, validateTags } from "../util";
import { CodeEditor, type CodeEditorHandle } from "../studio/CodeEditor";
import { StudioPreview, type StudioConsoleEntry } from "../studio/StudioPreview";
import { STUDIO_TEMPLATES } from "../studio/templates";
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
  loadProjectFromStorage,
  normalizeProjectPath,
  projectFromFileList,
  saveProjectToStorage,
  slugify,
  validateProject,
  withLeaderboard,
  ALLOWED_EXTENSIONS,
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

function PublishDialog({ project, onClose }: { project: StudioProject; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const m = asManifest(project.manifest);
  const [values, setValues] = useState<GameFieldValues>({ title: typeof m.name === "string" ? m.name.slice(0, 80) : "", description: "", tags: "", published: true });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GameFieldValues, string>>>({});
  const busy = progress !== null;
  const ref = useModal<HTMLFormElement>(true, onClose, { initialFocus: "#pf-game-title", canClose: !busy });
  const uid = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const tags = parseTags(values.tags);
    const errs: typeof fieldErrors = {};
    if (!values.title.trim()) errs.title = "Title is required.";
    const tagErr = validateTags(tags);
    if (tagErr) errs.tags = tagErr;
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    // R11: catch everything the backend would reject before uploading anything.
    const problems = validateProject(project);
    if (problems.length) {
      setError(`Fix these problems first: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const zip = await buildBundleZipAsync(project);
      const sizeErr = checkBundleSize(zip);
      if (sizeErr) {
        setProgress(null);
        setError(sizeErr);
        return;
      }
      const bundle = new File([zip], `${slugify(values.title)}.zip`, { type: "application/zip" });
      const game = await api.createGame({ title: values.title.trim(), description: values.description, tags, published: values.published, bundle }, (p) =>
        setProgress(p.fraction),
      );
      toast.success("Published!", `${game.title} is ${game.published ? "live" : "saved as a draft"}.`);
      navigate(`/games/${game.id}`);
    } catch (err) {
      setProgress(null);
      setError(isApiError(err) && err.code === "validation" ? `The bundle was rejected: ${err.message}` : errorMessage(err));
    }
  };

  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="pf-modal pf-modal--wide pf-form" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref} onSubmit={submit}>
        <h2 id={`${uid}-title`}>Publish to the arcade</h2>
        <GameFields values={values} onChange={setValues} disabled={busy} errors={fieldErrors} />
        {progress !== null && <ProgressBar value={progress} label="Uploading" />}
        {error && <Alert>{error}</Alert>}
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="pf-btn pf-btn--primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} Publish
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Game Studio: edit, run and publish a game in the browser. Usable logged out; publishing needs an account. */
export function StudioPage() {
  useDocumentTitle("Studio");
  const platform = usePlatform();
  const { user } = useAuth();
  const toast = useToast();
  const [project, setProject] = useState<StudioProject>(() => loadProjectFromStorage() ?? templateProject("blank"));
  const [selected, setSelected] = useState<string>(() => {
    const m = asManifest(project.manifest);
    return typeof m.entry === "string" && m.entry in project.files ? m.entry : MANIFEST;
  });
  const [runId, setRunId] = useState(1);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "too-large">("saved");
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [errorLine, setErrorLine] = useState<{ file: string; line: number } | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const logId = useRef(0);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const consoleRef = useRef<HTMLOListElement>(null);

  const manifest = asManifest(project.manifest);
  const problems = useMemo(() => validateProject(project), [project]);
  const size = useMemo(() => projectSize(project), [project]);
  const fileNames = useMemo(() => Object.keys(project.files).sort((a, b) => a.localeCompare(b)), [project.files]);

  // Autosave (debounced).
  useEffect(() => {
    setSaveState("saving");
    const t = setTimeout(() => setSaveState(saveProjectToStorage(project) ? "saved" : "too-large"), 500);
    return () => clearTimeout(t);
  }, [project]);

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

  const loadProject = (p: StudioProject, source: string) => {
    setProject(p);
    const m = asManifest(p.manifest);
    setSelected(typeof m.entry === "string" && m.entry in p.files ? m.entry : MANIFEST);
    setLogs([{ level: "info", message: `Opened ${source}.`, id: ++logId.current, time: Date.now() }]);
    setErrorLine(null);
    setRunId((n) => n + 1);
  };

  const setFile = (path: string, data: string | ArrayBuffer) => setProject((p) => ({ ...p, files: { ...p.files, [path]: data } }));

  const openFolder = async () => {
    if (platform.openLocalProject) {
      try {
        const p = await platform.openLocalProject();
        if (p) loadProject({ manifest: p.manifest, files: { ...p.files } }, "local folder");
      } catch (e) {
        toast.error("Couldn't open the folder", errorMessage(e));
      }
      return;
    }
    dirInputRef.current?.click();
  };

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
      loadProject(p, "folder");
      if (skipped.length) toast.info(`Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"}`, `Unsupported types: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);
    } catch (e) {
      toast.error("Couldn't open the folder", errorMessage(e));
    } finally {
      if (dirInputRef.current) dirInputRef.current.value = "";
    }
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
      setProject((p) => ({ ...p, files: { ...p.files, ...added } }));
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
    setProject((p) => {
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
    setProject((p) => {
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

  return (
    <div className="pf-studio">
      <header className="pf-studio__bar">
        <div className="pf-studio__title">
          <h1>Studio</h1>
          <span className="pf-muted pf-small" aria-live="polite">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved in this browser" : "⚠ Too large to autosave"}
          </span>
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
            onChange={(e) => e.target.value && setPendingTemplate(e.target.value)}
          >
            <option value="">New from template…</option>
            {STUDIO_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" className="pf-btn pf-btn--sm" onClick={openFolder}>
            📂 Open folder
          </button>
          <input
            ref={dirInputRef}
            type="file"
            hidden
            multiple
            onChange={(e) => void onDirPicked(e.target.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
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

      <div className="pf-studio__body">
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
            <ManifestForm project={project} onChange={(m) => setProject((p) => ({ ...p, manifest: m }))} />
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
      </div>

      <ConfirmDialog
        open={pendingTemplate !== null}
        title="Replace the current project?"
        confirmLabel="Replace"
        danger
        onCancel={() => setPendingTemplate(null)}
        onConfirm={() => {
          const t = STUDIO_TEMPLATES.find((x) => x.id === pendingTemplate);
          if (t) loadProject(templateProject(t.id), `the “${t.name}” template`);
          setPendingTemplate(null);
        }}
      >
        Your current project in the Studio will be overwritten. Export it as a .zip first if you want to keep it.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete ?? ""}?`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteFile(confirmDelete)}
      />
      {publishing && <PublishDialog project={project} onClose={() => setPublishing(false)} />}
    </div>
  );
}
