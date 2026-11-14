import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TabPanel, Tabs, ToggleGroup } from "../components/Tabs";

type V = "a" | "b" | "c";
const ITEMS = [
  { value: "a" as const, label: "Alpha" },
  { value: "b" as const, label: "Beta" },
  { value: "c" as const, label: "Gamma" },
];

function Harness({ activation, onChange }: { activation?: "automatic" | "manual"; onChange?: (v: V) => void }) {
  const [v, setV] = useState<V>("b");
  return (
    <>
      <Tabs
        id="t"
        label="Letters"
        items={ITEMS}
        value={v}
        activation={activation}
        onChange={(x) => {
          setV(x);
          onChange?.(x);
        }}
      />
      <TabPanel id="t" value={v}>
        Panel {v}
      </TabPanel>
    </>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs (N6)", () => {
  it("implements the WAI-ARIA tab roles and relationships", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Letters" });
    expect(list.querySelectorAll('[role="tab"]')).toHaveLength(3);
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("t-panel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Beta").id);
    expect(screen.getByRole("tabpanel", { name: "Beta" })).toBe(panel);
    for (const name of ["Alpha", "Beta", "Gamma"]) expect(tab(name).getAttribute("aria-controls")).toBe("t-panel");
    expect(tab("Beta").getAttribute("aria-selected")).toBe("true");
    expect(tab("Alpha").getAttribute("aria-selected")).toBe("false");
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tab("Beta").tabIndex).toBe(0);
    expect(tab("Alpha").tabIndex).toBe(-1);
    expect(tab("Gamma").tabIndex).toBe(-1);
  });

  it("moves focus and selection with Left/Right (wrapping), Home and End", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    act(() => tab("Beta").focus());
    fireEvent.keyDown(tab("Beta"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Gamma"));
    expect(tab("Gamma").getAttribute("aria-selected")).toBe("true");
    expect(tab("Gamma").tabIndex).toBe(0);
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel c");

    fireEvent.keyDown(tab("Gamma"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Alpha"));
    fireEvent.keyDown(tab("Alpha"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Gamma"));
    fireEvent.keyDown(tab("Gamma"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Alpha"));
    fireEvent.keyDown(tab("Alpha"), { key: "End" });
    expect(document.activeElement).toBe(tab("Gamma"));
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["c", "a", "c", "a", "c"]);

    // Other keys are left alone.
    fireEvent.keyDown(tab("Gamma"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("Gamma"));
  });

  it("manual activation moves focus only; click selects", () => {
    const onChange = vi.fn();
    render(<Harness activation="manual" onChange={onChange} />);
    act(() => tab("Beta").focus());
    fireEvent.keyDown(tab("Beta"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Alpha"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(tab("Alpha"));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(tab("Alpha").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the selected tab is a no-op", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(tab("Beta"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ToggleGroup (N6)", () => {
  it("renders a labelled group of aria-pressed buttons, not tabs", () => {
    const onChange = vi.fn();
    render(<ToggleGroup label="Sort" items={ITEMS} value="a" onChange={onChange} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    expect(screen.getByRole("group", { name: "Sort" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
