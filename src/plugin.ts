/**
 * Agentic Control Plane — OpenClaw Plugin
 *
 * Registers a `before_tool_call` hook that sends every tool invocation
 * to ACP for governance. ACP handles identity, policy evaluation, rate
 * limiting, content scanning, and audit logging server-side.
 *
 * The agent cannot bypass this — it runs at the process level.
 *
 * Install:
 *   openclaw plugins install @gatewaystack/acp-governance
 *
 * Configure:
 *   Store ACP credentials: ~/.acp/credentials
 *   (Run install.sh or set up via ACP dashboard)
 */

import { checkAcpGovernance } from "./govern.js";

// Map OpenClaw agent IDs to ACP tiers
function resolveAgentTier(agentId: string): string {
  // OpenClaw agent IDs: "main" (primary), "ops", "dev", custom names
  // "main" = the primary interactive agent → interactive tier
  // Sub-agents spawned for tasks → subagent tier
  // Everything else → interactive as safe default
  if (agentId === "main") return "interactive";
  if (agentId === "unknown") return "interactive";
  return "subagent"; // named agents are sub-agents
}

const plugin = {
  id: "acp-governance",
  name: "Agentic Control Plane",
  description:
    "Identity, governance, and audit for every tool call via the Agentic Control Plane. See all activity at cloud.agenticcontrolplane.com",

  register(api: any) {
    // before_tool_call: check with ACP, can block
    api.on(
      "before_tool_call",
      async (
        event: { toolName: string; params: Record<string, unknown> },
        ctx: { agentId?: string; sessionKey?: string }
      ) => {
        const agentId = ctx.agentId ?? "unknown";
        const result = await checkAcpGovernance({
          toolName: event.toolName,
          toolInput: JSON.stringify(event.params),
          agentId,
          sessionKey: ctx.sessionKey,
          agentTier: resolveAgentTier(agentId),
        });

        if (!result.allowed) {
          return {
            block: true,
            blockReason: `[ACP] ${result.reason}`,
          };
        }

        return {};
      },
      { priority: 0 }
    );

    if (api.logger) {
      api.logger.info("Agentic Control Plane governance active");
    }
  },
};

export default plugin;
