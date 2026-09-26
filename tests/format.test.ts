import { describe, it, expect } from "vitest";
import { formatSnapshot, formatLiveText } from "../src/format.js";
import { collectSnapshot } from "../src/snapshot.js";

function snap() {
  return collectSnapshot({
    cwd: "/tmp/foo",
    contextChunks: [{ source: "file", label: "AGENTS.md", text: "context text", y: 0, onscreen: true }],
    promptBlocks: [{ label: "guideline test", text: "prompt text", y: 0, active: true }],
    harnessTools: [{ name: "read", description: "Read", active: true, origin: "core" }],
    loopState: { iteration: 1, pending: ["iter 1 active"], cost: 1200 },
    graphTasks: [{ id: "t0", label: "task", depends: [], status: "pending", y: 0 }],
  });
}

describe("formatSnapshot", () => {
  it("contains header, stats, and elements", () => {
    const s = snap();
    const out = formatSnapshot(s);
    expect(out).toContain("NEXUS nexus:/tmp/foo");
    expect(out).toContain("Fingerprint:");
    expect(out).toContain("Stats:");
    expect(out).toContain("--- RANKED TEXT");
    expect(out).toContain("--- ELEMENTS");
    expect(out).toContain("[e1]");
  });
  it("compact flag shortens element lines", () => {
    const s = snap();
    const full = formatSnapshot(s, { compact: false });
    const compact = formatSnapshot(s, { compact: true });
    expect(compact.length).toBeLessThanOrEqual(full.length + 200); // compact roughly shorter
    expect(compact).toContain("kind=");
  });
});

describe("formatLiveText", () => {
  it("formats query mode", () => {
    expect(formatLiveText("hello world", { length: 100, query: "hello" })).toContain('LIVE QUERY "hello"');
  });
  it("formats chunk mode", () => {
    expect(formatLiveText("abc", { length: 100, offset: 10, limit: 50 })).toContain("LIVE CHUNK 10..13 of 100");
  });
});
