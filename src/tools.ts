// @ts-ignore - pi provides these at runtime via jiti
import { Type } from "@earendil-works/pi-ai";
// @ts-ignore
import { defineTool } from "@earendil-works/pi-coding-agent";
import { collectSnapshot, type NexusSnapshot } from "./snapshot.js";
import { formatSnapshot, formatLiveText } from "./format.js";
import { readFile } from "node:fs/promises";

let lastSnapshot: NexusSnapshot | null = null;
let lastFullText = "";
let iteration = 0;
let cwd = process.cwd();

// helpers to collect from pi runtime - lightweight, no deps
async function gatherContextChunks(query?: string): Promise<{ source: string; label: string; text: string; y: number; onscreen: boolean }[]> {
  // For scaffold: synthesize from available filesystem hints; real impl hooks pi sessionManager
  const chunks: { source: string; label: string; text: string; y: number; onscreen: boolean }[] = [];
  // try read recent memory / skill files if exist
  const candidates = ["AGENTS.md", "README.md", ".pi/memory.md", "plan.json"];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const txt = await readFile(candidates[i], "utf8").catch(() => "");
      if (!txt) continue;
      chunks.push({ source: "file", label: `${candidates[i]}`, text: txt.slice(0, 1200), y: i, onscreen: i < 2 });
    } catch {}
  }
  if (query) {
    // mark onscreen those matching query
    const q = query.toLowerCase();
    for (const c of chunks) if (c.text.toLowerCase().includes(q)) c.onscreen = true;
  }
  if (chunks.length === 0) {
    chunks.push({ source: "memory", label: "empty context - no AGENTS/README yet", text: "No context chunks. Add AGENTS.md or use query to rank.", y: 0, onscreen: true });
  }
  return chunks;
}

async function gatherPromptBlocks(): Promise<{ label: string; text: string; y: number; active: boolean }[]> {
  return [
    { label: "guideline: no scroll hunt", text: "ANTI-PATTERN: do not scroll hunt via bash grep loops, use ranked snapshot", y: 0, active: true },
    { label: "guideline: typed decisions", text: "Force operation+target in one JSON via TypeBox choice", y: 1, active: true },
    { label: "skill: nexus-laya", text: "Unified harness snapshot covering context/prompt/harness/loop/graph", y: 2, active: true },
  ];
}

function gatherHarnessTools(pi: any): { name: string; description: string; active: boolean; origin: string }[] {
  try {
    const tools: any[] = pi?.registeredTools ? Array.from((pi.registeredTools as any).keys?.() ?? []) : [];
    if (Array.isArray(tools) && tools.length) return tools.slice(0, 50).map((n: any) => ({ name: String(n), description: String(n), active: true, origin: "core" }));
  } catch {}
  return [
    { name: "read", description: "Read file", active: true, origin: "core" },
    { name: "bash", description: "Execute bash", active: true, origin: "core" },
    { name: "edit", description: "Edit file", active: true, origin: "core" },
    { name: "nexus_launch", description: "Nexus launch", active: true, origin: "nexus-laya" },
    { name: "nexus_snapshot", description: "Nexus snapshot", active: true, origin: "nexus-laya" },
    { name: "nexus_act", description: "Nexus act", active: true, origin: "nexus-laya" },
    { name: "nexus_text", description: "Nexus text", active: true, origin: "nexus-laya" },
  ];
}

async function gatherGraphTasks(): Promise<{ id: string; label: string; depends: number[]; status: string; y: number }[]> {
  try {
    const raw = await readFile("plan.json", "utf8").catch(() => "");
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j.tasks)) return j.tasks.slice(0, 50).map((t: string, i: number) => ({ id: `t${i}`, label: String(t).slice(0, 80), depends: [], status: "pending", y: i }));
    }
  } catch {}
  return [{ id: "t0", label: "no plan.json yet - add plan to enable graph area", depends: [], status: "pending", y: 0 }];
}

async function buildSnapshot(query?: string, pi?: any): Promise<NexusSnapshot> {
  const [contextChunks, promptBlocks, graphTasks] = await Promise.all([
    gatherContextChunks(query),
    gatherPromptBlocks(),
    gatherGraphTasks(),
  ]);
  const harnessTools = gatherHarnessTools(pi);
  const snap = collectSnapshot({
    cwd, query,
    contextChunks, promptBlocks, harnessTools,
    loopState: { iteration, pending: iteration > 0 ? [`iter ${iteration} active`] : [], cost: iteration * 1200 },
    graphTasks,
  });
  lastSnapshot = snap;
  lastFullText = snap.text; // ranked text is also full for scaffold; real impl keeps 100k raw
  // store raw length for pagination
  (snap as any)._rawLength = snap.fullTextLength;
  return snap;
}

// ---------- nexus_launch ----------
export const nexusLaunchTool = defineTool({
  name: "nexus_launch",
  label: "Nexus Launch",
  description: "Unified atomic snapshot: context+prompt+harness+loop+graph in one evaluate. Returns ranked 12k + e1..250 indexed items with y/onscreen/frame hints. Use ONLY these nexus tools for harness state, not bash grep loops. For beyond 12k use nexus_text.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Relevance query for TF-IDF ranking (e.g. 'auth middleware')" })),
  }),
  async execute(_id: any, params: any, ctx: any) {
    cwd = ctx?.cwd || process.cwd();
    iteration++;
    const snap = await buildSnapshot(params.query, ctx?.pi ?? null);
    return {
      content: [{ type: "text", text: formatSnapshot(snap) }],
      details: { fingerprint: snap.fingerprint, actions: snap.actions.length, ranked: snap.ranked },
    };
  },
});

// ---------- nexus_snapshot ----------
export const nexusSnapshotTool = defineTool({
  name: "nexus_snapshot",
  label: "Nexus Snapshot",
  description: "Re-observe harness atomically (one evaluate). Returns ranked 12k + element table. Use compact:true for 250+ items, query for relevance rank.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Relevance query - re-ranks 50k->12k" })),
    compact: Type.Optional(Type.Boolean({ description: "Compact table (auto on 250+)" })),
  }),
  async execute(_id: any, params: any, ctx: any) {
    const snap = await buildSnapshot(params?.query, ctx?.pi ?? null);
    return {
      content: [{ type: "text", text: formatSnapshot(snap, { compact: params?.compact }) }],
      details: { actions: snap.actions.length },
    };
  },
});

// ---------- nexus_act (batched, typed choice) ----------
export const nexusActTool = defineTool({
  name: "nexus_act",
  label: "Nexus Act (batched)",
  description: 'Batched 1-5 typed acts in one call then auto re-observe. Use ONLY this for harness actions. For prompt edits: [{"id":"eXX","text":"new guideline"}]. Batch: [{"id":"e5"},{"id":"e12","text":"fix"}]. Elements are from last snapshot e1..250. Guards prevent stale fingerprint.',
  parameters: Type.Object({
    actions: Type.Array(Type.Object({
      id: Type.String({ description: "Element id e1..250 or wait" }),
      text: Type.Optional(Type.String({ description: "Text for fill/prompt edit" })),
    }), { description: "Batch 1-5" }),
    query: Type.Optional(Type.String({ description: "Relevance query for post-act re-observe" })),
    compact: Type.Optional(Type.Boolean()),
  }),
  async execute(_id: any, params: any, ctx: any) {
    if (!lastSnapshot) lastSnapshot = await buildSnapshot(params?.query, ctx?.pi ?? null);
    const snap = lastSnapshot!;
    // validate + guard
    for (const a of params.actions) {
      if (a.id === "wait") continue;
      const found = snap.actions.find((x) => x.id === a.id);
      if (!found) throw new Error(`Unknown ${a.id}. Have: ${snap.actions.slice(0, 20).map((x) => `${x.id}:${x.label.slice(0, 25)}`).join(", ")}`);
      if (found.disabled) throw new Error(`Guard blocked ${a.id} "${found.label}" disabled:${found.disabled} - re-observe first`);
    }
    // simulate act effects
    let note = "";
    for (const a of params.actions) {
      const el = snap.actions.find((x) => x.id === a.id);
      if (el?.area === "prompt" && a.text) note += `\n[Prompt edit ${a.id} "${el.label}" -> "${a.text.slice(0, 60)}"]`;
      else if (el) note += `\n[Act ${a.id} "${el.label}" area=${el.area}]`;
      else note += `\n[Wait]`;
    }
    iteration++;
    const next = await buildSnapshot(params?.query, ctx?.pi ?? null);
    const diffNote = note ? `\n\n[Act feedback]${note}` : "";
    return {
      content: [{ type: "text", text: formatSnapshot(next, { compact: params.compact }) + diffNote }],
      details: { executed: params.actions.map((a: any) => a.id) },
    } as any;
  },
});

// ---------- nexus_text (live reader) ----------
export const nexusTextTool = defineTool({
  name: "nexus_text",
  label: "Nexus Text",
  description: 'Live harness text reader for beyond 12k. Modes: no params -> head 12k; {query:"phrase"} -> context around match; {offset,limit} -> pagination (negative offset = from end); {blockIndex:N} -> Nth block split by blank lines. Generic, no hardcode.',
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Substring to search live text" })),
    offset: Type.Optional(Type.Number({ description: "Char offset; negative from end (e.g. -5000)" })),
    limit: Type.Optional(Type.Number({ description: "Chars to return (default 12000, query default 3000)" })),
    blockIndex: Type.Optional(Type.Number({ description: "1-based block index split by blank lines" })),
  }),
  async execute(_id: any, params: any) {
    const full = lastFullText || lastSnapshot?.text || "";
    const length = (lastSnapshot as any)?._rawLength ?? full.length;
    if (params.blockIndex) {
      const blocks = full.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      const idx = Number(params.blockIndex) - 1;
      if (idx < 0 || idx >= blocks.length) {
        return { content: [{ type: "text", text: `Block ${params.blockIndex} out of range (have ${blocks.length}). First 5:\n${blocks.slice(0, 5).map((s, i) => `${i + 1}. ${s.slice(0, 400)}`).join("\n\n")}` }], details: { count: blocks.length } } as any;
      }
      return { content: [{ type: "text", text: `Block ${params.blockIndex}/${blocks.length}:\n${blocks[idx]}` }], details: { index: params.blockIndex } } as any;
    }
    if (params.query) {
      const q = params.query.toLowerCase();
      const idx = full.toLowerCase().indexOf(q);
      if (idx === -1) return { content: [{ type: "text", text: `No match for "${params.query}" in ${length} chars. Try offset or different query.` }], details: {} } as any;
      const lim = params.limit ?? 3000;
      const start = Math.max(0, idx - Math.floor(lim / 3));
      const ctx = full.slice(start, start + lim);
      return { content: [{ type: "text", text: formatLiveText(ctx, { length, query: params.query }) }], details: {} } as any;
    }
    if (params.offset !== undefined || params.limit !== undefined) {
      const off = params.offset ?? 0;
      const lim = params.limit ?? 12000;
      const start = off < 0 ? Math.max(0, length + off) : off;
      const chunk = full.slice(start, start + lim);
      return { content: [{ type: "text", text: formatLiveText(chunk, { length, offset: start, limit: lim }) }], details: {} } as any;
    }
    const head = full.slice(0, 12000);
    const note = length > 12000 ? `\n\n[Full ${length} chars, showing head 12k. Use query/offset/blockIndex]` : "";
    return { content: [{ type: "text", text: head + note }], details: { length } } as any;
  },
});

export function getLastSnapshot() { return lastSnapshot; }
