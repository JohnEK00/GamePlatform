import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
};

export type TabsProps<T extends string> = {
  /** Shared id prefix; pass the same value to the matching `<TabPanel>`. Must be unique on the page. */
  id: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
  /**
   * "automatic" (default): arrow keys move focus and select the tab.
   * "manual": arrow keys only move focus; Enter/Space selects.
   */
  activation?: "automatic" | "manual";
};

/** The DOM id of the tab for `value` inside the `Tabs` with this `id`. */
export const tabId = (id: string, value: string) => `${id}-tab-${value}`;
/** The DOM id of the tab panel paired with the `Tabs` with this `id`. */
export const tabPanelId = (id: string) => `${id}-panel`;

/**
 * WAI-ARIA tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): `role="tablist"` of `role="tab"`
 * buttons with `aria-selected`, `aria-controls`, a roving tabindex and Left/Right/Home/End keys. Render
 * the content in a `<TabPanel id={sameId} value={value}>` (it may live elsewhere in the layout).
 */
export function Tabs<T extends string>({ id, items, value, onChange, label, className, activation = "automatic" }: TabsProps<T>) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = items.length;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = (index + 1) % n;
        break;
      case "ArrowLeft":
        next = (index - 1 + n) % n;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const target = items[next];
    refs.current.get(target.value)?.focus();
    if (activation === "automatic" && target.value !== value) onChange(target.value);
  };

  return (
    <div className={className ? `pf-tabs ${className}` : "pf-tabs"} role="tablist" aria-label={label} aria-orientation="horizontal">
      {items.map((t, i) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              if (el) refs.current.set(t.value, el);
              else refs.current.delete(t.value);
            }}
            id={tabId(id, t.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(id)}
            tabIndex={selected ? 0 : -1}
            className={`pf-tab${selected ? " is-active" : ""}`}
            onClick={() => {
              if (!selected) onChange(t.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export type TabPanelProps = {
  /** Same `id` as the controlling `<Tabs>`. */
  id: string;
  /** The currently selected tab value (labels the panel). */
  value: string;
  className?: string;
  children?: ReactNode;
};

/** The `role="tabpanel"` region for a `<Tabs>`; labelled by the selected tab. */
export function TabPanel({ id, value, className, children }: TabPanelProps) {
  return (
    <div id={tabPanelId(id)} role="tabpanel" aria-labelledby={tabId(id, value)} tabIndex={0} className={className ? `pf-tabpanel ${className}` : "pf-tabpanel"}>
      {children}
    </div>
  );
}

export type ToggleGroupProps<T extends string> = {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
};

/**
 * A segmented control that is *not* a tab list (e.g. a sort order): a `role="group"` of toggle buttons
 * with `aria-pressed`. Styled like `Tabs`.
 */
export function ToggleGroup<T extends string>({ items, value, onChange, label, className }: ToggleGroupProps<T>) {
  return (
    <div className={className ? `pf-tabs ${className}` : "pf-tabs"} role="group" aria-label={label}>
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button key={t.value} type="button" aria-pressed={selected} className={`pf-tab${selected ? " is-active" : ""}`} onClick={() => onChange(t.value)}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
