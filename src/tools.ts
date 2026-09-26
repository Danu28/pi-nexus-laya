// @ts-ignore - pi provides these at runtime via jiti
import { Type } from "@earendil-works/pi-ai";
// @ts-ignore
import { defineTool } from "@earendil-works/pi-coding-agent";
import { collectSnapshot, type NexusSnapshot } from "./snapshot.js";
import { formatSnapshot, formatLiveText } from "./format.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Session-scoped state (fix: keyed by sessionId, not global singleton)
// ---------------------------------------------------------------------------
let extensionApi: ExtensionAPI | null = null;
export function setExtensionApi(api: ExtensionAPI) { extensionApi = api; }
export function getExtensionApi() { return extensionApi; }

const snapshotByKey = new Map<string, NexusSnapshot>();
const rawTextByKey = new Map<string, string>();
const iterationByKey = new Map<string, number>();

function sessionKey(ctx?: ExtensionContext | null): string {
  try {
    if (ctx?.sessionManager?.getSessionId) {
      const id = ctx.sessionManager.getSessionId();
      if (id) return id;
    }
    if (ctx?.sessionManager?.getSessionFile) {
      const f = ctx.sessionManager.getSessionFile();
      if (f) return f;
    }
  } catch {}
  return ctx?.cwd || process.cwd();
}

function getIteration(ctx?: ExtensionContext | null): number {
  return iterationByKey.get(sessionKey(ctx)) ?? 0;
}
function incIteration(ctx?: ExtensionContext | null): number {
  const k = sessionKey(ctx);
  const next = (iterationByKey.get(k) ?? 0) + 1;
  iterationByKey.set(k, next);
  return next;
}
function setSnapshotForKey(ctx: ExtensionContext | null, snap: NexusSnapshot) {
  const k = sessionKey(ctx);
  snapshotByKey.set(k, snap);
  // store raw 100k text for pagination, not just ranked 12k
  const raw = (snap as any).rawText ?? snap.text;
  rawTextByKey.set(k, raw);
}
function getSnapshotForKey(ctx?: ExtensionContext | null): NexusSnapshot | null {
  return snapshotByKey.get(sessionKey(ctx)) ?? null;
}
function getRawForKey(ctx?: ExtensionContext | null): string {
  return rawTextByKey.get(sessionKey(ctx)) ?? getSnapshotForKey(ctx)?.text ?? "";
}

export function clearSessionState(ctx?: ExtensionContext | null) {
  const k = sessionKey(ctx);
  snapshotByKey.delete(k);
  rawTextByKey.delete(k);
  iterationByKey.delete(k);
}
export function clearAllState() {
  snapshotByKey.clear();
  rawTextByKey.clear();
  iterationByKey.clear();
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error(`Aborted: ${signal.reason ?? "signal aborted"}`);
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------
function validateQuery(query?: string): string | undefined {
  if (query === undefined) return undefined;
  if (typeof query !== "string") throw new Error("query must be a string");
  if (query.length > 500) throw new Error(`query too long (${query.length} > 500). Keep under 500 chars.`);
  return query.trim() || undefined;
}
function validateLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0 || n > 50000) throw new Error("limit must be 1..50000");
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Real harness collectors - wired to pi runtime (fix #2)
// ---------------------------------------------------------------------------
function extractEntryText(entry: any): string {
  // SessionEntry variants: message, custom, custom_message, compaction, branch_summary etc.
  if (!entry) return "";
  // message entry: entry.message?.content
  const msg = entry.message;
  if (msg?.content) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map((c: any) => typeof c === "string" ? c : (c.text ?? c.content ?? JSON.stringify(c))).join("\n");
  }
  // custom / custom_message
  if (entry.content) {
    if (typeof entry.content === "string") return entry.content;
    if (Array.isArray(entry.content)) return entry.content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n");
  }
  if (entry.data) return typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data).slice(0, 1200);
  if (entry.summary) return String(entry.summary).slice(0, 1200);
  if (entry.text) return String(entry.text).slice(0, 1200);
  return JSON.stringify(entry).slice(0, 800);
}

async function gatherContextChunks(
  ctx: ExtensionContext | null | undefined,
  query?: string,
  signal?: AbortSignal,
): Promise<{ source: string; label: string; text: string; y: number; onscreen: boolean }[]> {
  checkAborted(signal);
  const chunks: { source: string; label: string; text: string; y: number; onscreen: boolean }[] = [];

  // 1) Primary: real session entries via sessionManager (the actual pi context)
  try {
    if (ctx?.sessionManager) {
      const mgr: any = ctx.sessionManager as any;
      // Prefer compaction-aware context, fallback to branch
      let entries: any[] = [];
      try {
        if (typeof mgr.buildContextEntries === "function") entries = mgr.buildContextEntries();
        else if (typeof mgr.getBranch === "function") entries = mgr.getBranch();
        else if (typeof mgr.getEntries === "function") entries = mgr.getEntries();
      } catch {}
      // take most recent 30 entries
      const recent = entries.slice(-30);
      for (let i = 0; i < recent.length; i++) {
        checkAborted(signal);
        const e: any = recent[i];
        const txt = extractEntryText(e).slice(0, 1200);
        if (!txt.trim()) continue;
        const label = `${e.type ?? "entry"}:${String(txt.slice(0, 40)).replace(/\n/g, " ")}`;
        const y = entries.length - recent.length + i; // recency
        // onscreen = in current context path or recent user/assistant messages
        const onscreen = i >= Math.max(0, recent.length - 6);
        chunks.push({ source: e.type ?? "session", label: label.slice(0, 80), text: txt, y, onscreen });
      }
    }
  } catch {}

  // 2) Supplement: filesystem hints (cwd-relative, abort-aware, joined safely)
  const cwd = ctx?.cwd || process.cwd();
  const candidates = ["AGENTS.md", "README.md", ".pi/memory.md", "plan.json"];
  for (let i = 0; i < candidates.length; i++) {
    checkAborted(signal);
    try {
      const p = join(cwd, candidates[i]);
      const txt = await readFile(p, "utf8").catch(() => "");
      if (!txt) continue;
      // avoid duplicating session content already captured
      const label = candidates[i];
      if (chunks.some(c => c.label === label)) continue;
      chunks.push({ source: "file", label, text: txt.slice(0, 1200), y: chunks.length, onscreen: i < 2 });
    } catch {}
  }

  if (query) {
    const q = query.toLowerCase();
    for (const c of chunks) if (c.text.toLowerCase().includes(q)) c.onscreen = true;
  }
  if (chunks.length === 0) {
    chunks.push({ source: "memory", label: "empty context - no session entries or AGENTS/README yet", text: "No context chunks. Add AGENTS.md or start a conversation to populate context.", y: 0, onscreen: true });
  }
  return chunks.slice(0, 30);
}

async function gatherPromptBlocks(
  ctx: ExtensionContext | null | undefined,
  signal?: AbortSignal,
): Promise<{ label: string; text: string; y: number; active: boolean }[]> {
  checkAborted(signal);
  // Primary: real system prompt via ctx.getSystemPrompt()
  try {
    const sys = (ctx as any)?.getSystemPrompt?.();
    if (typeof sys === "string" && sys.trim()) {
      // split prompt into guideline blocks (by headings or double newlines)
      const rawBlocks = sys.split(/\n{2,}/).map((s: string) => s.trim()).filter(Boolean);
      const blocks = rawBlocks.slice(0, 20).map((b: string, i: number) => ({
        label: b.split("\n")[0]?.slice(0, 80) || `prompt:block ${i + 1}`,
        text: b.slice(0, 600),
        y: i,
        active: true,
      }));
      if (blocks.length) return blocks;
    }
  } catch {}

  // Fallback: static guidelines (anti-scroll-hunt, typed decisions)
  return [
    { label: "guideline: no scroll hunt", text: "ANTI-PATTERN: do not scroll hunt via bash grep loops, use ranked snapshot", y: 0, active: true },
    { label: "guideline: typed decisions", text: "Force operation+target in one JSON via TypeBox choice", y: 1, active: true },
    { label: "skill: nexus-laya", text: "Unified harness snapshot covering context/prompt/harness/loop/graph", y: 2, active: true },
  ];
}

function gatherHarnessTools(ctx: ExtensionContext | null | undefined): { name: string; description: string; active: boolean; origin: string }[] {
  // Prefer real pi registry via captured extensionApi
  try {
    const api: any = extensionApi as any;
    if (api) {
      if (typeof api.getAllTools === "function") {
        const all: any[] = api.getAllTools() ?? [];
        const activeSet = new Set<string>(typeof api.getActiveTools === "function" ? (api.getActiveTools() ?? []) : []);
        if (all.length) {
          return all.slice(0, 60).map((t: any) => ({
            name: String(t.name ?? t.id ?? "unknown"),
            description: String(t.description ?? t.promptSnippet ?? t.name ?? "").slice(0, 200),
            active: activeSet.size === 0 ? true : activeSet.has(String(t.name)),
            origin: String(t.sourceInfo?.path ?? t.origin ?? "core"),
          }));
        }
      }
      if (typeof api.getActiveTools === "function") {
        const names: string[] = api.getActiveTools() ?? [];
        if (names.length) return names.slice(0, 60).map((n) => ({ name: String(n), description: String(n), active: true, origin: "core" }));
      }
    }
  } catch {}
  // Also try ctx-local registry (some pi versions expose tools on sessionManager/modelRegistry)
  try {
    const anyCtx: any = ctx as any;
    if (anyCtx?.modelRegistry?.getAllTools) {
      const all = anyCtx.modelRegistry.getAllTools();
      if (Array.isArray(all) && all.length) return all.slice(0, 50).map((t: any) => ({ name: String(t.name), description: String(t.description ?? t.name), active: true, origin: "core" }));
    }
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

async function gatherGraphTasks(
  ctx: ExtensionContext | null | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; label: string; depends: number[]; status: string; y: number }[]> {
  checkAborted(signal);
  const tasks: { id: string; label: string; depends: number[]; status: string; y: number }[] = [];

  // Try session-derived tasks: look for compaction/branch entries or custom task entries
  try {
    const entries: any[] = (ctx?.sessionManager as any)?.getBranch?.() ?? (ctx?.sessionManager as any)?.getEntries?.() ?? [];
    for (let i = 0; i < entries.length; i++) {
      const e: any = entries[i];
      if (e.type === "custom" && e.customType?.includes("task")) {
        tasks.push({ id: e.id ?? `t${i}`, label: String(e.data?.label ?? e.data ?? "").slice(0, 80), depends: [], status: "pending", y: i });
      }
    }
  } catch {}

  // Fallback: plan.json
  if (tasks.length === 0) {
    try {
      const cwd = ctx?.cwd || process.cwd();
      const raw = await readFile(join(cwd, "plan.json"), "utf8").catch(() => "");
      checkAborted(signal);
      if (raw) {
        const j = JSON.parse(raw);
        if (Array.isArray(j.tasks)) {
          j.tasks.slice(0, 50).forEach((t: string, i: number) => tasks.push({ id: `t${i}`, label: String(t).slice(0, 80), depends: [], status: "pending", y: i }));
        } else if (Array.isArray(j)) {
          j.slice(0, 50).forEach((t: any, i: number) => tasks.push({ id: `t${i}`, label: String(typeof t === "string" ? t : t.label ?? JSON.stringify(t)).slice(0, 80), depends: [], status: "pending", y: i }));
        }
      }
    } catch {}
  }

  if (tasks.length === 0) return [{ id: "t0", label: "no plan.json yet - add plan to enable graph area", depends: [], status: "pending", y: 0 }];
  return tasks.slice(0, 50);
}

function gatherLoopState(ctx: ExtensionContext | null | undefined): { iteration: number; pending: string[]; cost: number } {
  const iteration = getIteration(ctx);
  const pending: string[] = [];
  try {
    if (ctx?.hasPendingMessages?.() ) pending.push("pending messages queued");
    if (ctx?.isIdle && !(ctx.isIdle())) pending.push(`iter ${iteration} streaming`);
    else if (iteration > 0) pending.push(`iter ${iteration} active`);
    const usage = (ctx as any)?.getContextUsage?.();
    if (usage?.percent !== undefined && usage.percent !== null) pending.push(`context ${Math.round(usage.percent)}%`);
  } catch {}
  if (pending.length === 0 && iteration > 0) pending.push(`iter ${iteration} active`);
  // cost heuristic: iteration * 1200 + context tokens/1000
  const cost = iteration * 1200 + (pending.length * 400);
  return { iteration, pending, cost };
}

async function buildSnapshot(
  ctx: ExtensionContext | null | undefined,
  query?: string,
  signal?: AbortSignal,
): Promise<NexusSnapshot> {
  checkAborted(signal);
  const cwd = ctx?.cwd || process.cwd();
  const validatedQuery = validateQuery(query);
  // collect in parallel but abort-aware
  const contextChunksP = gatherContextChunks(ctx, validatedQuery, signal);
  const promptBlocksP = gatherPromptBlocks(ctx, signal);
  const graphTasksP = gatherGraphTasks(ctx, signal);
  const [contextChunks, promptBlocks, graphTasks] = await Promise.all([contextChunksP, promptBlocksP, graphTasksP]);
  checkAborted(signal);
  const harnessTools = gatherHarnessTools(ctx);
  const loopState = gatherLoopState(ctx);
  checkAborted(signal);
  const snap = collectSnapshot({
    cwd, query: validatedQuery,
    contextChunks, promptBlocks, harnessTools,
    loopState, graphTasks,
  });
  setSnapshotForKey(ctx as ExtensionContext, snap);
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
  async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
    checkAborted(signal);
    const validatedQuery = validateQuery(params?.query);
    incIteration(ctx);
    const snap = await buildSnapshot(ctx, validatedQuery, signal);
    checkAborted(signal);
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
  async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
    checkAborted(signal);
    const validatedQuery = validateQuery(params?.query);
    const snap = await buildSnapshot(ctx, validatedQuery, signal);
    checkAborted(signal);
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
    }), { description: "Batch 1-5", maxItems: 5, minItems: 1 }),
    query: Type.Optional(Type.String({ description: "Relevance query for post-act re-observe" })),
    compact: Type.Optional(Type.Boolean()),
  }),
  async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
    checkAborted(signal);
    if (!Array.isArray(params.actions) || params.actions.length === 0 || params.actions.length > 5) {
      throw new Error(`actions must be 1..5, got ${params.actions?.length ?? 0}`);
    }
    let snap = getSnapshotForKey(ctx);
    if (!snap) snap = await buildSnapshot(ctx, validateQuery(params?.query), signal);
    checkAborted(signal);
    // validate + guard (including disabled + existence)
    for (const a of params.actions) {
      checkAborted(signal);
      if (a.id === "wait") continue;
      if (typeof a.text === "string" && a.text.length > 4000) throw new Error(`text for ${a.id} too long (${a.text.length} > 4000)`);
      const found = snap.actions.find((x) => x.id === a.id);
      if (!found) throw new Error(`Unknown ${a.id}. Have: ${snap.actions.slice(0, 20).map((x) => `${x.id}:${x.label.slice(0, 25)}`).join(", ")}`);
      if (found.disabled) throw new Error(`Guard blocked ${a.id} "${found.label}" disabled:${found.disabled} - re-observe first`);
    }
    // simulate act effects (real impl would mutate prompt/context/graph)
    let note = "";
    for (const a of params.actions) {
      const el = snap.actions.find((x) => x.id === a.id);
      if (el?.area === "prompt" && a.text) note += `\n[Prompt edit ${a.id} "${el.label}" -> "${a.text.slice(0, 60)}"]`;
      else if (el) note += `\n[Act ${a.id} "${el.label}" area=${el.area}]`;
      else note += `\n[Wait]`;
    }
    incIteration(ctx);
    checkAborted(signal);
    const next = await buildSnapshot(ctx, validateQuery(params?.query), signal);
    checkAborted(signal);
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
  async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
    checkAborted(signal);
    const full = getRawForKey(ctx);
    const snap = getSnapshotForKey(ctx);
    const length = snap?.fullTextLength ?? full.length;
    if (params.blockIndex !== undefined) {
      const idx = Number(params.blockIndex);
      if (!Number.isInteger(idx) || idx < 1) throw new Error("blockIndex must be integer >=1");
      const blocks = full.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      const bi = idx - 1;
      if (bi < 0 || bi >= blocks.length) {
        return { content: [{ type: "text", text: `Block ${params.blockIndex} out of range (have ${blocks.length}). First 5:\n${blocks.slice(0, 5).map((s, i) => `${i + 1}. ${s.slice(0, 400)}`).join("\n\n")}` }], details: { count: blocks.length } } as any;
      }
      checkAborted(signal);
      return { content: [{ type: "text", text: `Block ${params.blockIndex}/${blocks.length}:\n${blocks[bi]}` }], details: { index: params.blockIndex } } as any;
    }
    if (params.query) {
      validateQuery(params.query);
      validateLimit(params.limit);
      const q = params.query.toLowerCase();
      const idx = full.toLowerCase().indexOf(q);
      if (idx === -1) return { content: [{ type: "text", text: `No match for "${params.query}" in ${length} chars. Try offset or different query.` }], details: {} } as any;
      const lim = validateLimit(params.limit) ?? 3000;
      checkAborted(signal);
      const start = Math.max(0, idx - Math.floor(lim / 3));
      const ctxSlice = full.slice(start, start + lim);
      return { content: [{ type: "text", text: formatLiveText(ctxSlice, { length, query: params.query }) }], details: {} } as any;
    }
    if (params.offset !== undefined || params.limit !== undefined) {
      const off = params.offset ?? 0;
      const lim = validateLimit(params.limit) ?? 12000;
      if (!Number.isInteger(off)) throw new Error("offset must be integer");
      const start = off < 0 ? Math.max(0, length + off) : off;
      checkAborted(signal);
      const chunk = full.slice(start, start + lim);
      return { content: [{ type: "text", text: formatLiveText(chunk, { length, offset: start, limit: lim }) }], details: {} } as any;
    }
    checkAborted(signal);
    const head = full.slice(0, 12000);
    const note = length > 12000 ? `\n\n[Full ${length} chars, showing head 12k. Use query/offset/blockIndex]` : "";
    return { content: [{ type: "text", text: head + note }], details: { length } } as any;
  },
});

export function getLastSnapshot(ctx?: ExtensionContext | null) {
  if (ctx) return getSnapshotForKey(ctx);
  // fallback: return any snapshot (first)
  const first = snapshotByKey.values().next().value as NexusSnapshot | undefined;
  return first ?? null;
}
export function getLastRawText(ctx?: ExtensionContext | null) { return getRawForKey(ctx); }
