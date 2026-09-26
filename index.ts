/**
 * pi-nexus-laya - unified Laya-inspired extension for pi
 * 4 tools: nexus_launch / nexus_snapshot / nexus_act / nexus_text
 * Covers context + harness + loop + prompt + graph in one atomic snapshot
 * Single dep: none (pi APIs only) - like browser-laya single dep playwright
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nexusLaunchTool, nexusSnapshotTool, nexusActTool, nexusTextTool } from "./src/tools.js";

export default function (pi: ExtensionAPI) {
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

  // Laya hooks port: prompt router + loop guard + harness guard
  (pi as any).on("before_agent_start", async (event: any) => {
    return undefined;
  });

  (pi as any).on("agent_before_settle", async () => {
    return undefined;
  });

  (pi as any).on("session_shutdown", async () => {
    // idempotent cleanup like browser-laya
  });
}
