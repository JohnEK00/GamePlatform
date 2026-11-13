import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";

export type CodeEditorHandle = {
  /** Moves the caret to a 1-based line/column and scrolls it into view. */
  goTo: (line: number, column?: number) => void;
  focus: () => void;
};

export type CodeEditorProps = {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl/Cmd+S */
  onRun?: () => void;
  label: string;
  readOnly?: boolean;
  /** 1-based line to highlight (e.g. an error) */
  errorLine?: number;
};

const INDENT = "  ";
const LINE_HEIGHT = 20; // px, must match .pf-editor CSS

/** Textarea code editor: line numbers, Tab / Shift+Tab indentation, auto-indent on Enter, Ctrl/Cmd+S to run. */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { value, onChange, onRun, label, readOnly, errorLine },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const lines = value.split("\n").length;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    goTo: (line, column = 1) => {
      const ta = taRef.current;
      if (!ta) return;
      const all = ta.value.split("\n");
      const l = Math.min(Math.max(1, line), all.length);
      let pos = 0;
      for (let i = 0; i < l - 1; i++) pos += all[i].length + 1;
      pos += Math.min(Math.max(0, column - 1), all[l - 1].length);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = Math.max(0, (l - 5) * LINE_HEIGHT);
    },
  }));

  /** Replace [start, end) with text and set the selection, keeping the browser undo stack where possible. */
  const edit = (ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart: number, selEnd = selStart) => {
    ta.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (!ok || ta.value.slice(start, start + text.length) !== text) {
      const next = ta.value.slice(0, start) + text + ta.value.slice(end);
      ta.value = next;
      onChange(next);
    }
    ta.setSelectionRange(selStart, selEnd);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (readOnly) return;
    const { selectionStart: s, selectionEnd: en, value: v } = ta;
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      if (s === en && !e.shiftKey) {
        edit(ta, s, en, INDENT, s + INDENT.length);
        return;
      }
      // Block (de)indent of every selected line.
      const blockEnd = en > s && v[en - 1] === "\n" ? en - 1 : en;
      const block = v.slice(lineStart, blockEnd);
      const blines = block.split("\n");
      let firstDelta = 0;
      const out = blines.map((l, i) => {
        if (!e.shiftKey) {
          if (i === 0) firstDelta = INDENT.length;
          return INDENT + l;
        }
        const rm = l.startsWith(INDENT) ? INDENT.length : l.startsWith(" ") || l.startsWith("\t") ? 1 : 0;
        if (i === 0) firstDelta = -rm;
        return l.slice(rm);
      });
      const text = out.join("\n");
      const newStart = Math.max(lineStart, s + firstDelta);
      edit(ta, lineStart, blockEnd, text, s === en ? newStart : newStart, s === en ? newStart : blockEnd + (text.length - block.length));
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))![0];
      const before = v.slice(lineStart, s).trimEnd();
      const extra = /[{[(]$/.test(before) ? INDENT : "";
      e.preventDefault();
      const after = v[en];
      if (extra && after && "}])".includes(after)) {
        const text = "\n" + indent + extra + "\n" + indent;
        edit(ta, s, en, text, s + 1 + indent.length + extra.length);
      } else {
        const text = "\n" + indent + extra;
        edit(ta, s, en, text, s + text.length);
      }
    }
  };

  return (
    <div className="pf-editor">
      <div className="pf-editor__gutter" ref={gutterRef} aria-hidden="true">
        <div style={{ transform: `translateY(${-scrollTop}px)` }}>
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={errorLine === i + 1 ? "is-error" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
      </div>
      <textarea
        ref={taRef}
        className="pf-editor__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        readOnly={readOnly}
        aria-label={label}
      />
    </div>
  );
});
