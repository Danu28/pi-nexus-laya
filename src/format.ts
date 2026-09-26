import type { NexusSnapshot } from "./snapshot.js";

export function formatSnapshot(snap: NexusSnapshot, opts?: { compact?: boolean }): string {
  const compact = opts?.compact ?? snap.actions.length > 200;
  const lines: string[] = [];
  lines.push(`NEXUS ${snap.title} (${snap.url})`);
  lines.push(`Fingerprint: ${snap.fingerprint} | Ranked: ${snap.ranked} | Full: ${snap.fullTextLength} chars -> 12k`);
  lines.push(`Stats: context=${snap.stats.context} prompt=${snap.stats.prompt} harness=${snap.stats.harness} loop=${snap.stats.loop} graph=${snap.stats.graph} | dedupedSkipped=${snap.dedupedSkipped} omitted=${snap.omitted}`);
  if (snap.relevanceQuery) lines.push(`Query: "${snap.relevanceQuery}"`);
  lines.push("");
  lines.push("--- RANKED TEXT (12k) ---");
  lines.push(snap.text);
  lines.push("");
  lines.push(`--- ELEMENTS (${snap.actions.length}) [e1..${snap.actions.length}] ---`);
  if (compact) {
    for (const a of snap.actions) {
      lines.push(`[${a.id}] ${a.area}:${a.role} "${a.label}" y=${a.y}${a.onscreen ? " onscreen" : ""}${a.disabled ? ` disabled:${a.disabled}` : ""}${a.frame ? ` frame:${a.frame}` : ""} kind=${a.kind}`);
    }
  } else {
    for (const a of snap.actions) {
      lines.push(`[${a.id}] [${a.area}] ${a.role} "${a.label}" | y=${a.y} onscreen=${a.onscreen} frame=${a.frame || "-"} kind=${a.kind} value="${(a.value || "").slice(0, 60)}"${a.disabled ? ` disabled=${a.disabled}` : ""}`);
    }
  }
  lines.push("");
  lines.push("Use: nexus_act [{\"id\":\"eXX\"}] for elements (typed choice). Use nexus_text {query|offset|blockIndex} for beyond-12k.");
  if (snap.fullTextLength > 12000) lines.push(`[Full ${snap.fullTextLength} chars, showing ranked 12k. Use nexus_text for remainder.]`);
  return lines.join("\n");
}

export function formatLiveText(text: string, meta: { length: number; offset?: number; limit?: number; query?: string }): string {
  if (meta.query) return `LIVE QUERY "${meta.query}" (${text.length}/${meta.length} chars)\n${text}`;
  if (meta.offset !== undefined) return `LIVE CHUNK ${meta.offset}..${meta.offset! + text.length} of ${meta.length}\n${text}`;
  return text;
}
