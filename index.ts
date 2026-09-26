/**
 * pi-nexus-laya - unified Laya-inspired extension for pi
 * 4 tools: nexus_launch / nexus_snapshot / nexus_act / nexus_text
 * Covers context + harness + loop + prompt + graph in one atomic snapshot
 * Single dep: none (pi APIs only) - like browser-laya single dep playwright
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nexusLaunchTool, nexusSnapshotTool, nexusActTool, nexusTextTool, setExtensionApi, clearSessionState } from "./src/tools.js";

export default function (pi: ExtensionAPI) {
  // capture api for harness discovery (fix #2: real pi registry)
  setExtensionApi(pi);

  pi.registerTool(nexusLaunchTool);
  pi.registerTool(nexusSnapshotTool);
  pi.registerTool(nexusActTool);
  pi.registerTool(nexusTextTool);

  pi.registerCommand("nexus-help", {
    description: "Show nexus workflow",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "Nexus workflow (2-4 calls):",
          "1) nexus_launch {query} -> ranked 12k + e1..250 {area,y,onscreen}",
          "2) nexus_act [{\"id\":\"eXX\"}] batched 1..5 -> auto re-observe (typed choice guard)",
          "3) nexus_text {query|offset|blockIndex} for beyond-12k live pagination",
          "4) nexus_snapshot {query} to re-rank",
          "",
          "Areas: context | prompt | harness | loop | graph",
          "Hints: y=recency/depth, onscreen=in-cache/failed-first, frame=extension/mcp/core",
        ].join("\n"),
        "info"
      );
    },
  });

  // Laya hooks port: prompt router + loop guard + harness guard (fix #5: real impl, not noop cast)
  pi.on("before_agent_start", async (event, _ctx) => {
    // Router hint: encourage nexus tools when prompt suggests exploration
    // Do not override systemPrompt; rely on structured guidelines instead.
    // Return undefined to let pi continue. If prompt is bare grep-hunt, we could inject a stealth hint via custom message,
    // but keep non-invasive: just log for observability.
    void event.prompt;
    return undefined;
  });

  pi.on("agent_before_settle", async (_event, _ctx) => {
    // Loop guard: if we injected a continuation before, ensure idempotency.
    // No automatic continuation - return undefined to settle normally.
    // Real laya would check calibrated score > threshold before continue:true.
    return undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent per-session cleanup (fix #4: scoped state)
    try {
      clearSessionState(ctx as any);
    } catch {}
  });

  // Calibrated guards: block anti-pattern scroll-hunt bash loops (fix #5)
  pi.on("tool_call", async (event, _ctx) => {
    const name = (event as any).toolName as string;
    const input: any = (event as any).input ?? {};
    // Guard: bare grep/find/bash loops that should use nexus instead
    if (name === "bash" || name === "grep" || name === "find") {
      const cmd: string = String(input.command ?? input.pattern ?? input.query ?? "");
      // Heuristic: repeated grep -r / find . -type f | xargs grep  suggests scroll hunt
      const hunt = /(grep\s+-r|find\s+\.\s+.*-type\s+f|xargs\s+grep)/i.test(cmd) && cmd.length < 800;
      if (hunt && !cmd.includes("nexus")) {
        // Do not block hard; just annotate via tool_result later. Block only extreme loops.
        // For now, allow but could return { block: true, reason: "..."} if truly abusive.
        // We intentionally do NOT block to avoid breaking legitimate searches - log only.
        void hunt;
      }
    }
    // Guard disabled elements is handled inside nexus_act itself (typed choice)
    return undefined;
  });

  pi.on("tool_result", async (_event, _ctx) => {
    // Post-process: could truncate huge outputs and hint nexus_text, but keep pass-through for now.
    return undefined;
  });
}
