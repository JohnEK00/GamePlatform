import type { CommentSort } from "../api/types";
import { ToggleGroup, type TabItem } from "./Tabs";

const SORT_ITEMS: readonly TabItem<CommentSort>[] = [
  { value: "new", label: "Newest" },
  { value: "top", label: "Top" },
];

export type CommentSortToggleProps = {
  value: CommentSort;
  onChange: (sort: CommentSort) => void;
  className?: string;
};

/**
 * F017 § 2.1: "Newest" / "Top" as a `role="group"` of `aria-pressed` buttons (a segmented control, not tabs).
 * The buttons stay mounted when the sort changes, so focus stays on the pressed one.
 */
export function CommentSortToggle({ value, onChange, className }: CommentSortToggleProps) {
  return (
    <ToggleGroup
      items={SORT_ITEMS}
      value={value}
      onChange={(next) => {
        if (next !== value) onChange(next);
      }}
      label="Sort comments"
      className={className ? `pf-segmented ${className}` : "pf-segmented"}
    />
  );
}
