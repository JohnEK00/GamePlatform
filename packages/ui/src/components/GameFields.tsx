import { parseTags } from "../util";

export type GameFieldValues = { title: string; description: string; tags: string; published: boolean };

/** Shared title/description/tags/published fields for the upload and edit forms. */
export function GameFields({
  values,
  onChange,
  disabled,
  errors = {},
}: {
  values: GameFieldValues;
  onChange: (v: GameFieldValues) => void;
  disabled?: boolean;
  errors?: Partial<Record<keyof GameFieldValues, string>>;
}) {
  const set = <K extends keyof GameFieldValues>(k: K, v: GameFieldValues[K]) => onChange({ ...values, [k]: v });
  const tags = parseTags(values.tags);
  return (
    <>
      <div className="pf-field">
        <label className="pf-label" htmlFor="pf-game-title">
          Title <span className="pf-req">*</span>
        </label>
        <input
          id="pf-game-title"
          className="pf-input"
          required
          maxLength={80}
          value={values.title}
          disabled={disabled}
          aria-invalid={!!errors.title || undefined}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Space Dodge"
        />
        {errors.title && <span className="pf-field__error">{errors.title}</span>}
      </div>
      <div className="pf-field">
        <label className="pf-label" htmlFor="pf-game-desc">
          Description
        </label>
        <textarea
          id="pf-game-desc"
          className="pf-input"
          rows={6}
          maxLength={5000}
          value={values.description}
          disabled={disabled}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What's the game about? How do you play? Controls?"
        />
        <span className="pf-field__hint">{values.description.length}/5000</span>
      </div>
      <div className="pf-field">
        <label className="pf-label" htmlFor="pf-game-tags">
          Tags
        </label>
        <input
          id="pf-game-tags"
          className="pf-input"
          value={values.tags}
          disabled={disabled}
          aria-invalid={!!errors.tags || undefined}
          aria-describedby="pf-game-tags-hint"
          onChange={(e) => set("tags", e.target.value)}
          placeholder="arcade, shooter, retro"
        />
        <span className="pf-field__hint" id="pf-game-tags-hint">
          Comma-separated, up to 8 tags of ≤ 24 characters.
        </span>
        {tags.length > 0 && (
          <div className="pf-chips pf-chips--preview">
            {tags.map((t) => (
              <span key={t} className={`pf-chip${t.length > 24 ? " pf-chip--bad" : ""}`}>
                #{t}
              </span>
            ))}
          </div>
        )}
        {errors.tags && <span className="pf-field__error">{errors.tags}</span>}
      </div>
      <label className="pf-switch">
        <input type="checkbox" checked={values.published} disabled={disabled} onChange={(e) => set("published", e.target.checked)} />
        <span className="pf-switch__track" aria-hidden="true" />
        <span>
          <strong>Published</strong>
          <span className="pf-muted pf-small"> — visible to everyone. Unpublished games are only visible to you.</span>
        </span>
      </label>
    </>
  );
}
