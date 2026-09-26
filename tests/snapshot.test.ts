import { describe, it, expect } from "vitest";
import { collectSnapshot, hashFingerprint } from "../src/snapshot.js";

function mkInput(over: Partial<Parameters<typeof collectSnapshot>[0]> = {}) {
  return {
    cwd: "/tmp/test",
    query: undefined as string | undefined,
    contextChunks: [{ source: "file", label: "AGENTS.md", text: "hello world context", y: 0, onscreen: true }],
    promptBlocks: [{ label: "guideline: test", text: "test guideline", y: 0, active: true }],
    harnessTools: [{ name: "read", description: "Read file", active: true, origin: "core" }],
    loopState: { iteration: 0, pending: [], cost: 0 },
    graphTasks: [{ id: "t0", label: "task 1", depends: [], status: "pending", y: 0 }],
    ...over,
  };
}

describe("hashFingerprint", () => {
  it("returns 16 hex chars and is deterministic", () => {
    const a = hashFingerprint(["/tmp", "hello", [1, 2], 3]);
    const b = hashFingerprint(["/tmp", "hello", [1, 2], 3]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
  it("changes when marker changes", () => {
    const a = hashFingerprint(["/tmp", "hello", [], 1]);
    const b = hashFingerprint(["/tmp", "hello", [], 2]);
    expect(a).not.toBe(b);
  });
  it("not truncated JSON prefix collision", () => {
    // old bug: slice(0,64) on JSON would collide for same cwd prefix
    const a = hashFingerprint(["C:/Users/dhanu/Desktop/Pi-Repos/Pi-Experiments/new-experiment/extensions/nexus-laya", "x".repeat(200), Array.from({ length: 250 }, (_, i) => ({ id: i, label: "tool" })), 1]);
    const b = hashFingerprint(["C:/Users/dhanu/Desktop/Pi-Repos/Pi-Experiments/new-experiment/extensions/nexus-laya", "y".repeat(200), Array.from({ length: 250 }, (_, i) => ({ id: i, label: "other" })), 1]);
    expect(a).not.toBe(b);
  });
});

describe("collectSnapshot", () => {
  it("returns ranked 12k and rawText full", () => {
    // context text is truncated to 800 per chunk, plus harness/loop/graph overhead -> need >15 chunks to exceed 12k
    const bigChunks: any = Array.from({ length: 20 }, (_, i) => ({ source: "file", label: `file${i}.md`, text: `block ${i} ` + "x".repeat(2000), y: i, onscreen: i < 2 }));
    const manyTools = Array.from({ length: 20 }, (_, i) => ({ name: `tool${i}`, description: `tool ${i} ` + "y".repeat(200), active: true, origin: "core" }));
    const snap = collectSnapshot({ ...mkInput(), contextChunks: bigChunks, harnessTools: manyTools as any });
    expect(snap.text.length).toBeLessThanOrEqual(12000);
    expect(snap.rawText.length).toBeGreaterThan(12000);
    expect(snap.fullTextLength).toBe(snap.rawText.length);
    expect(snap.ranked).toBe(true);
    expect(snap.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
  it("prioritizes query terms in ranking", () => {
    const chunks = [
      { source: "file", label: "auth.md", text: "auth middleware token jwt " + "x".repeat(2000), y: 10, onscreen: false },
      { source: "file", label: "readme.md", text: "generic readme " + "x".repeat(2000), y: 0, onscreen: true },
    ];
    const snapNoQuery = collectSnapshot(mkInput({ contextChunks: chunks as any }));
    const snapQuery = collectSnapshot(mkInput({ query: "auth middleware", contextChunks: chunks as any }));
    // query snap should still contain auth block in ranked text
    expect(snapQuery.text.toLowerCase()).toContain("auth");
    expect(snapQuery.relevanceQuery).toBe("auth middleware");
    expect(snapNoQuery.relevanceQuery).toBe("");
  });
  it("dedups over-repeated labels", () => {
    const dup = Array.from({ length: 10 }, () => ({ source: "file", label: "AGENTS.md", text: "same content", y: 0, onscreen: true }));
    const snap = collectSnapshot(mkInput({ contextChunks: dup as any }));
    expect(snap.dedupedSkipped).toBeGreaterThan(0);
    expect(snap.actions.length).toBeLessThan(10 + 3); // 10 dup + prompt/harness/loop/graph
  });
  it("caps actions at 250 and reports omitted", () => {
    const manyTools = Array.from({ length: 300 }, (_, i) => ({ name: `tool${i}`, description: `tool ${i}`, active: true, origin: "core" }));
    const snap = collectSnapshot(mkInput({ harnessTools: manyTools as any }));
    expect(snap.actions.length).toBe(250);
    expect(snap.omitted).toBeGreaterThan(0);
    expect(snap.actions[0].id).toBe("e1");
    expect(snap.actions[249].id).toBe("e250");
  });
  it("handles MAX_COLLECT truncation", () => {
    const huge = [{ source: "file", label: "huge.md", text: "H".repeat(110000), y: 0, onscreen: true }];
    const snap = collectSnapshot(mkInput({ contextChunks: huge as any }));
    expect(snap.rawText.length).toBeLessThanOrEqual(100000);
    expect(snap.fullTextLength).toBeLessThanOrEqual(100000);
  });
  it("guards structure and marker", () => {
    const snap = collectSnapshot(mkInput());
    expect(snap.guards).toBeDefined();
    expect(snap.marker).toHaveLength(4);
    expect(snap.scroll).toEqual(expect.objectContaining({ y: expect.any(Number), height: expect.any(Number) }));
    expect(snap.stats).toEqual(expect.objectContaining({ context: 1, prompt: 1, harness: 1 }));
  });
});
