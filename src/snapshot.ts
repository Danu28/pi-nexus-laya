/**
 * pi-nexus-laya - atomic harness snapshot
 * Port of browser-laya src/snapshot.js + browser.ts for pi harness
 * One evaluate scans 5 roots: context | prompt | harness | loop | graph -> 50k->12k ranked + 250 eXX
 */

export type NexusArea = "context" | "prompt" | "harness" | "loop" | "graph";
export type NexusRole = "memory" | "skill" | "guideline" | "tool" | "continuation" | "task" | "file" | "block";

export interface NexusAction {
  id: string; // e1..250
  node: number;
  area: NexusArea;
  role: NexusRole;
  label: string;
  y: number; // recency/depth/cost like rect.y
  onscreen: boolean; // in-cache / in-critical-path / failed-first
  frame?: string; // extension/mcp/core
  disabled?: string;
  kind: "click" | "fill" | "select" | "wait" | "scroll";
  value?: string;
  score?: number;
}

export interface NexusSnapshot {
  url: string; // cwd
  title: string;
  text: string; // ranked 12k
  fullTextLength: number;
  ranked: boolean;
  relevanceQuery: string;
  actions: NexusAction[];
  guards: Record<number, unknown[]>;
  marker: unknown[];
  fingerprint: string;
  omitted: number;
  dedupedSkipped: number;
  scroll: { y: number; height: number };
  stats: { context: number; prompt: number; harness: number; loop: number; graph: number };
}

// --- ranking: same as browser-laya ---
const MAX_TEXT = 12000;
const MAX_COLLECT = 100000;

function rankText(fullTextRaw: string, relevanceQuery: string): { text: string; ranked: boolean } {
  if (fullTextRaw.length <= MAX_TEXT) return { text: fullTextRaw.slice(0, MAX_TEXT), ranked: false };
  const queryTerms = relevanceQuery
    ? relevanceQuery.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10)
    : [];

  let blocks = fullTextRaw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocks.length < 3) {
    const lines = fullTextRaw.split("\n").filter(Boolean);
    blocks = [];
    let buf = "";
    for (const l of lines) {
      buf += (buf ? "\n" : "") + l;
      if (buf.length > 600) {
        blocks.push(buf);
        buf = "";
      }
    }
    if (buf) blocks.push(buf);
  }

  const scored = blocks.map((b, idx) => {
    let score = 0;
    const lower = b.toLowerCase();
    if (/^#{1,6}\s/.test(b)) score += 80 - (b.match(/^#+/) || ["#"])[0]!.length * 8;
    if (/^\[(context|prompt|harness|loop|graph|skill|memory|task):/.test(b)) score += 20;
    if (idx < 3) score += 15 - idx * 3;
    if (idx === blocks.length - 1) score += 8;
    if (b.length >= 80 && b.length <= 800) score += 10;
    else if (b.length < 20) score -= 5;
    if (queryTerms.length) {
      let qHits = 0;
      for (const t of queryTerms) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const m = lower.match(re);
        if (m) qHits += m.length * (t.length > 4 ? 12 : 8);
      }
      score += qHits;
      if (relevanceQuery && lower.includes(relevanceQuery.toLowerCase())) score += 25;
    }
    return { b, idx, score, len: b.length };
  });

  scored.sort((a, b) => b.score - a.score);
  let picked: typeof scored = [];
  let total = 0;
  for (const s of scored) {
    if (total + s.len + 2 > MAX_TEXT) continue;
    picked.push(s);
    total += s.len + 2;
    if (total >= MAX_TEXT * 0.92) break;
  }
  if (total < MAX_TEXT * 0.7) {
    const pickedIdx = new Set(picked.map((p) => p.idx));
    for (const s of scored.sort((a, b) => a.idx - b.idx)) {
      if (pickedIdx.has(s.idx)) continue;
      if (total + s.len + 2 > MAX_TEXT) break;
      picked.push(s);
      total += s.len + 2;
    }
  }
  picked.sort((a, b) => a.idx - b.idx);
  let text = picked.map((p) => p.b).join("\n\n");
  if (text.length < 4000 && fullTextRaw.length >= 4000) {
    const head = fullTextRaw.slice(0, 4000);
    if (!text.includes(head.slice(0, 200))) text = head + "\n\n" + text;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  }
  return { text, ranked: true };
}

// --- collector ---
let nextNodeId = 1;
const nodeToScope = new Map<number, string>();

function identity(scopeText: string): number {
  const id = nextNodeId++;
  nodeToScope.set(id, scopeText);
  return id;
}

export interface CollectInput {
  cwd: string;
  query?: string;
  // injected by tools.ts from pi context
  contextChunks: { source: string; label: string; text: string; y: number; onscreen: boolean }[];
  promptBlocks: { label: string; text: string; y: number; active: boolean }[];
  harnessTools: { name: string; description: string; active: boolean; origin: string }[];
  loopState: { iteration: number; pending: string[]; cost: number };
  graphTasks: { id: string; label: string; depends: number[]; status: string; y: number }[];
}

export function collectSnapshot(input: CollectInput): NexusSnapshot {
  nextNodeId = 1;
  nodeToScope.clear();

  const actions: NexusAction[] = [];
  const words: string[] = [];
  let length = 0;

  const pushText = (s: string) => {
    if (length >= MAX_COLLECT) return;
    words.push(s);
    length += s.length;
  };

  // 1) CONTEXT - heading annotated
  pushText(`# Context (${input.contextChunks.length} chunks)`);
  for (const c of input.contextChunks) {
    pushText(`[context: ${c.source}] ${c.label}\n${c.text.slice(0, 800)}`);
    const node = identity(c.text.slice(0, 6000));
    actions.push({
      id: "", node, area: "context", role: "memory", label: c.label.slice(0, 80),
      y: c.y, onscreen: c.onscreen, kind: "click", value: c.text.slice(0, 200),
    });
  }

  // 2) PROMPT
  pushText(`\n# Prompt (${input.promptBlocks.length} blocks)`);
  for (const p of input.promptBlocks) {
    pushText(`[prompt: guideline] ${p.label}\n${p.text.slice(0, 600)}`);
    const node = identity(p.text.slice(0, 6000));
    actions.push({
      id: "", node, area: "prompt", role: "guideline", label: p.label.slice(0, 80),
      y: p.y, onscreen: p.active, kind: p.active ? "click" : "fill", value: p.text.slice(0, 200),
      disabled: p.active ? undefined : "inactive",
    });
  }

  // 3) HARNESS
  pushText(`\n# Harness (${input.harnessTools.length} tools)`);
  for (const t of input.harnessTools) {
    pushText(`[harness: tool] ${t.name} ${t.active ? "(active)" : "(inactive)"} - ${t.description.slice(0, 120)}`);
    const node = identity(t.description);
    actions.push({
      id: "", node, area: "harness", role: "tool", label: `${t.name} ${t.active ? "" : "(inactive)"}`.trim(),
      y: 0, onscreen: t.active, frame: t.origin, kind: "click", value: t.name,
      disabled: t.active ? undefined : "inactive",
    });
  }

  // 4) LOOP
  pushText(`\n# Loop (iter ${input.loopState.iteration}, cost ${input.loopState.cost})`);
  for (const p of input.loopState.pending) {
    pushText(`[loop: continuation] ${p}`);
  }
  {
    const node = identity(input.loopState.pending.join("\n"));
    actions.push({
      id: "", node, area: "loop", role: "continuation", label: `Loop iter ${input.loopState.iteration} pending: ${input.loopState.pending.join(", ").slice(0, 60) || "settled"}`,
      y: input.loopState.iteration, onscreen: input.loopState.pending.length > 0, kind: "click", value: String(input.loopState.iteration),
    });
  }

  // 5) GRAPH
  pushText(`\n# Graph (${input.graphTasks.length} tasks)`);
  for (const g of input.graphTasks) {
    pushText(`[graph: task] ${g.label} depends:${g.depends.join(",") || "-"} status:${g.status}`);
    const node = identity(g.label);
    actions.push({
      id: "", node, area: "graph", role: "task", label: g.label.slice(0, 80),
      y: g.y, onscreen: g.status === "failed" || g.status === "active", kind: "click", value: g.id,
      disabled: g.status === "blocked" ? "blocked" : undefined,
    });
  }

  const fullTextRaw = words.join("\n\n");
  const { text, ranked } = rankText(fullTextRaw, input.query || "");

  // prioritization: context/prompt pinned + failed tasks first, like browser fill/select first
  actions.sort((a, b) => {
    const prio: Record<string, number> = { memory: 0, guideline: 0, task: 1, continuation: 1, tool: 2 };
    const pa = prio[a.role] ?? 2, pb = prio[b.role] ?? 2;
    if (pa !== pb) return pa - pb;
    if (a.onscreen !== b.onscreen) return a.onscreen ? -1 : 1;
    return a.y - b.y;
  });

  // dedup like browser-laya
  const seen = new Map<string, number>();
  const deduped: NexusAction[] = [];
  let dedupedSkipped = 0;
  for (const a of actions) {
    const key = `${a.area}|${a.role}|${String(a.label).toLowerCase().trim()}`.slice(0, 120);
    const c = seen.get(key) ?? 0;
    if (c >= 3 && a.kind === "click" && a.role !== "task") { dedupedSkipped++; continue; }
    seen.set(key, c + 1);
    deduped.push(a);
  }
  const finalActions = dedupedSkipped ? deduped : actions;
  const omitted = Math.max(0, finalActions.length - 250);
  finalActions.splice(250);
  finalActions.forEach((a, i) => (a.id = `e${i + 1}`));

  // guards
  const guards: Record<number, unknown[]> = {};
  for (const a of finalActions) {
    guards[a.node] = [a.node, a.role, a.label, a.value ?? null, a.area, a.y, a.onscreen, a.disabled ?? null, nodeToScope.get(a.node)?.slice(0, 6000) ?? ""];
  }

  const marker = [input.cwd, text.slice(0, 200), finalActions.map(({ id, ...rest }) => rest), input.loopState.iteration];
  const fingerprint = JSON.stringify(marker).slice(0, 64);

  return {
    url: input.cwd,
    title: `nexus:${input.cwd}`,
    text,
    fullTextLength: fullTextRaw.length,
    ranked,
    relevanceQuery: input.query || "",
    actions: finalActions,
    guards,
    marker,
    fingerprint,
    omitted,
    dedupedSkipped,
    scroll: { y: input.loopState.iteration, height: Math.max(10, input.graphTasks.length) },
    stats: {
      context: input.contextChunks.length,
      prompt: input.promptBlocks.length,
      harness: input.harnessTools.length,
      loop: input.loopState.pending.length,
      graph: input.graphTasks.length,
    },
  };
}
