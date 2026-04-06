import { checkAcpGovernance } from "./govern.js";

// Matches openclaw/plugin-sdk/plugin-entry types — declared here so we
// don't need the full openclaw package (500MB+) as a build dependency.
interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface PluginHookAgentContext {
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  modelProviderId: string;
  modelId: string;
  trigger: string;
  channelId: string;
}

interface OpenClawPluginApi {
  on(
    hook: string,
    handler: (event: any, ctx: any) => any,
    opts?: { priority?: number; name?: string; description?: string }
  ): void;
}

function resolveAgentTier(agentId: string): string {
  if (agentId === "main") return "interactive";
  if (agentId === "unknown") return "interactive";
  return "subagent";
}

// Use definePluginEntry at runtime (resolved from openclaw peer dep),
// fall back to plain object if not available (e.g. linked installs).
let definePluginEntry: (opts: any) => any;
try {
  definePluginEntry = require("openclaw/plugin-sdk/plugin-entry").definePluginEntry;
} catch {
  definePluginEntry = (opts: any) => opts;
}

export default definePluginEntry({
  id: "acp-governance",
  name: "Agentic Control Plane",
  description:
    "Identity, governance, and audit for every tool call via the Agentic Control Plane. See all activity at cloud.agenticcontrolplane.com",

  register(api: OpenClawPluginApi) {
    api.on(
      "before_tool_call",
      async (
        event: PluginHookBeforeToolCallEvent,
        ctx: PluginHookAgentContext
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
  },
});
