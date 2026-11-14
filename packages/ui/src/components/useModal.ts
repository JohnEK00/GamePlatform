import { useEffect, useRef, type RefObject } from "react";

/** Elements that can take keyboard focus (used for the initial focus and the Tab trap). */
const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable=true]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Focusable descendants of `root`, in DOM order, skipping hidden ones. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hidden || el.closest("[hidden],[inert]")) return false;
    if (el instanceof HTMLInputElement && el.type === "radio" && !el.checked) {
      // Only the checked radio of a group is a Tab stop (or the first if none is checked).
      if (!el.name) return true;
      const group = Array.from(root.querySelectorAll<HTMLInputElement>("input[type=radio]")).filter((r) => r.name === el.name);
      const anyChecked = group.some((r) => r.checked);
      return !anyChecked && group[0] === el;
    }
    return true;
  });
}

export type UseModalOptions = {
  /** CSS selector (inside the dialog) for the element to focus first. Defaults to `[data-autofocus]`, then the first focusable element. */
  initialFocus?: string;
  /** When false, Escape does nothing (e.g. while a request is in flight). Default true. */
  canClose?: boolean;
};

// Open modals, innermost last: only the top one reacts to Escape / Tab.
const stack: object[] = [];

/**
 * Accessible modal behaviour for a dialog element (R9): moves focus into it when it opens, keeps Tab and
 * Shift+Tab inside it, closes on Escape, and gives focus back to the element that opened it on close.
 * The element itself should carry `role="dialog" aria-modal="true" aria-labelledby=…`.
 *
 * Returns the ref to attach to the dialog element.
 */
export function useModal<T extends HTMLElement = HTMLElement>(open: boolean, onClose: () => void, opts: UseModalOptions = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const latest = useRef({ onClose, opts });
  latest.current = { onClose, opts };

  useEffect(() => {
    if (!open) return;
    const token = {};
    stack.push(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isTop = () => stack[stack.length - 1] === token;

    const focusInitial = () => {
      const root = ref.current;
      if (!root) return;
      const sel = latest.current.opts.initialFocus;
      const target =
        (sel ? root.querySelector<HTMLElement>(sel) : null) ?? root.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(root)[0] ?? root;
      if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      target.focus();
    };
    focusInitial();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      const root = ref.current;
      if (!root) return;
      if (e.key === "Escape") {
        if (latest.current.opts.canClose === false) return;
        e.preventDefault();
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that escapes anyway (mouse click on the backdrop page, programmatic focus) is pulled back.
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop()) return;
      const root = ref.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) focusInitial();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  return ref;
}
