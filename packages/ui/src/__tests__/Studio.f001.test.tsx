import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { StudioPreview, type StudioConsoleEntry } from "../studio/StudioPreview";
import { leaderboardOf, validateProject, withLeaderboard, type StudioProject } from "../studio/project";
import { STUDIO_TEMPLATES } from "../studio/templates";
import { WebGameProviders } from "../WebGameApp";

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function setup(manifest: object) {
  const project: StudioProject = { manifest: { name: "T", entry: "main.js", width: 320, height: 240, ...manifest }, files: { "main.js": "export default {}" } };
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const getLb = vi.spyOn(client, "getLeaderboard");
  const submit = vi.spyOn(client, "submitScore");
  const logs: StudioConsoleEntry[] = [];
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <StudioPreview project={project} runId={1} onLog={(e) => logs.push(e)} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  const w = utils.container.querySelector("iframe")!.contentWindow!;
  const spy = vi.spyOn(w, "postMessage");
  return { w, spy, logs, getLb, submit };
}

const sent = (spy: { mock: { calls: unknown[][] } }, type: string) =>
  spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === type);

afterEach(() => vi.restoreAllMocks());

describe("Studio sample leaderboard (F001)", () => {
  it("answers with 5 deterministic sample entries respecting asc/time, without API calls", () => {
    const { w, spy, logs, getLb } = setup({ leaderboard: { order: "asc", format: "time", label: "Best time" } });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "day", limit: 10 });
    const [reply] = sent(spy, "webgame:leaderboard") as { requestId: string; leaderboard: Record<string, unknown> & { entries: { name: string; score: number; display: string; isMe: boolean; rank: number }[] } }[];
    expect(reply.requestId).toBe("lb-1");
    const lb = reply.leaderboard;
    expect(lb).toMatchObject({ period: "day", order: "asc", format: "time", label: "Best time", totalPlayers: 5, me: null, sample: true });
    expect(lb.entries.map((e) => e.name)).toEqual(["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"]);
    expect(lb.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]);
    const scores = lb.entries.map((e) => e.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(lb.entries[0].display).toMatch(/^\d+:\d{2}\.\d{3}$/);
    expect(lb.entries.every((e) => !e.isMe)).toBe(true);
    expect(getLb).not.toHaveBeenCalled();
    expect(logs.some((l) => /sample leaderboard data/.test(l.message))).toBe(true);

    // Deterministic: the same request gives the same board; the note is shown once per session.
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-2", period: "day", limit: 10 });
    const replies = sent(spy, "webgame:leaderboard") as { leaderboard: unknown }[];
    expect(replies[1].leaderboard).toEqual(lb);
    expect(logs.filter((l) => /sample leaderboard data/.test(l.message)).length).toBe(1);
  });

  it("uses defaults (desc, number) when the manifest has no leaderboard", () => {
    const { w, spy } = setup({});
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "all", limit: 3 });
    const [reply] = sent(spy, "webgame:leaderboard") as { leaderboard: { order: string; format: string; entries: { score: number }[] } }[];
    expect(reply.leaderboard.order).toBe("desc");
    expect(reply.leaderboard.format).toBe("number");
    const scores = reply.leaderboard.entries.map((e) => e.score);
    expect(scores.length).toBe(3);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("answers score requests with error studio and ignores malformed requests", () => {
    const { w, spy, logs, submit } = setup({});
    post(w, { type: "webgame:score", score: 10, requestId: "sc-1" });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "year", limit: 3 });
    expect(sent(spy, "webgame:score-result")).toEqual([{ type: "webgame:score-result", requestId: "sc-1", result: null, error: "studio" }]);
    expect(sent(spy, "webgame:leaderboard")).toEqual([]);
    expect(logs.some((l) => /Would submit score 10/.test(l.message))).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("Studio leaderboard manifest helpers (F001)", () => {
  it("omits the key when all values are defaults", () => {
    const m = withLeaderboard({ name: "x" }, { order: "asc" });
    expect(m.leaderboard).toEqual({ order: "asc" });
    const m2 = withLeaderboard(m, { format: "time", label: "Best time" });
    expect(m2.leaderboard).toEqual({ order: "asc", format: "time", label: "Best time" });
    const m3 = withLeaderboard(withLeaderboard(withLeaderboard(m2, { order: "desc" }), { format: "number" }), { label: "" });
    expect("leaderboard" in m3).toBe(false);
    expect(leaderboardOf(m3)).toEqual({ order: "desc", format: "number", label: "" });
  });

  it("validates the leaderboard block", () => {
    const base = { name: "x", entry: "main.js", width: 320, height: 240 };
    const files = { "main.js": "" };
    expect(validateProject({ manifest: { ...base, leaderboard: { order: "up" } }, files }).join(" ")).toMatch(/leaderboard\.order/);
    expect(validateProject({ manifest: { ...base, leaderboard: { label: "x".repeat(25) } }, files }).join(" ")).toMatch(/leaderboard\.label/);
    expect(validateProject({ manifest: { ...base, leaderboard: { order: "asc", format: "time" } }, files })).toEqual([]);
  });

  it("ships a Time trial template", () => {
    const t = STUDIO_TEMPLATES.find((x) => x.id === "time-trial")!;
    expect(t.name).toBe("Time trial");
    expect(t.manifest.leaderboard).toMatchObject({ order: "asc", format: "time" });
    expect(t.files["main.js"]).toContain("getLeaderboard({ period: \"day\", limit: 5 })");
    expect(t.files["main.js"]).toContain("submitScore(ms)");
    expect(validateProject({ manifest: t.manifest, files: t.files })).toEqual([]);
  });
});
