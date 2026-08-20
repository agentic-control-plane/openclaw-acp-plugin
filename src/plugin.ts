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

// openclaw's own PluginApprovalResolutions enum (src/plugins/types.ts).
// Mirrored as a type rather than imported so the plugin still builds
// without the openclaw package present.
type PluginApprovalResolution = "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";

type RequireApprovalSpec = {
  pluginId: string;
  title: string;
  description: string;
  severity: "warning" | "critical";
  timeoutMs: number;
  timeoutBehavior: "deny" | "allow";
  onResolution: (resolution: PluginApprovalResolution) => void;
};

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

// requireApproval is only safe to send if this host build actually acts on
// it. On openclaw 2026.4.5 (the peer floor — verified against the shipped
// hook runner), before_tool_call consumption checks `hookResult.block`
// before it ever looks at `hookResult.requireApproval`
// (pi-embedded's runBeforeToolCallHook), so a host that ignores
// requireApproval, or one sent both fields on the same handler return,
// silently takes the plain block path and never opens an approval prompt.
// There's no capability flag on the hook API to test for this directly, so
// probe for the resolution enum that same runtime build exports alongside
// requireApproval support (openclaw/plugin-sdk/plugin-runtime). If that
// shape isn't there, we've never verified this host drives the approval
// flow, and fall back to the one primitive guaranteed to be honored
// everywhere: a hard block.
function isApprovalResolutionMap(value: unknown): value is Record<string, string> {
  const r = value as Record<string, unknown> | null | undefined;
  return Boolean(
    r &&
      typeof r.ALLOW_ONCE === "string" &&
      typeof r.ALLOW_ALWAYS === "string" &&
      typeof r.DENY === "string" &&
      typeof r.TIMEOUT === "string" &&
      typeof r.CANCELLED === "string"
  );
}

// Test-only escape hatch: lets the test suite exercise both branches
// without a real openclaw install in node_modules. Production code never
// sets this, so hostSupportsRequireApproval() always takes the real probe
// below.
export const __testing = { approvalSupportOverride: undefined as boolean | undefined };

function hostSupportsRequireApproval(): boolean {
  if (__testing.approvalSupportOverride !== undefined) return __testing.approvalSupportOverride;
  try {
    const mod = require("openclaw/plugin-sdk/plugin-runtime");
    return isApprovalResolutionMap(mod?.PluginApprovalResolutions);
  } catch {
    return false;
  }
}

const APPROVAL_TITLE_MAX = 80;
const APPROVAL_DESCRIPTION_MAX = 256;

// The gateway prefixes `reason` this way when it has already opened its
// own approval doc for this call (step_up creates one server-side and
// notifies approvers independently of anything OpenClaw does). See #718
// follow-up: there is no client-callable endpoint to resolve that doc from
// here, so the two prompts stay separate — this is just making sure the
// human sees that they're the same call.
const ACP_APPROVAL_EXISTS_PREFIXES = ["approval-requested:", "approval-pending:"];

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildApprovalSpec(params: {
  toolName: string;
  decision: string;
  reason: string;
}): { title: string; description: string; severity: "warning" | "critical" } {
  const alreadyInAcp = ACP_APPROVAL_EXISTS_PREFIXES.some((prefix) => params.reason.startsWith(prefix));
  const title = truncate(`ACP approval needed: ${params.toolName}`, APPROVAL_TITLE_MAX);
  const base = `${params.toolName}: ${params.reason} — this rule came from your workspace's ACP policy.`;
  const existingApprovalNote = alreadyInAcp
    ? " An ACP approval for this call already exists at cloud.agenticcontrolplane.com — approving here does not resolve it, so you may be asked twice for the same call."
    : "";
  const description = truncate(`${base}${existingApprovalNote}`, APPROVAL_DESCRIPTION_MAX);
  // step_up is the higher bar — an elevated-scope requirement, not just a
  // policy threshold — so it gets the top severity band.
  const severity = params.decision === "step_up" ? "critical" : "warning";
  return { title, description, severity };
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

        // before_tool_call's return value only merges params/block/
        // blockReason/requireApproval — there's no non-blocking message
        // field, so an infrastructure lapse that doesn't block would
        // otherwise vanish. stderr is the loud channel for that case; a
        // blocked lapse is already loud via blockReason below.
        if (result.ungoverned) {
          process.stderr.write(`[ACP] ${result.reason}\n`);
        }

        if (!result.allowed) {
          if (result.decision === "ask" || result.decision === "step_up") {
            // Everything from feature-detection through building the
            // approval spec is guarded: any failure here falls back to a
            // hard block rather than risk a malformed or half-built
            // requireApproval object silently doing nothing. (The host
            // has its own outer catch around plugin hooks that would also
            // block on a thrown error, but this doesn't rely on that.)
            try {
              if (hostSupportsRequireApproval()) {
                const { title, description, severity } = buildApprovalSpec({
                  toolName: event.toolName,
                  decision: result.decision,
                  reason: result.reason,
                });
                const requireApproval: RequireApprovalSpec = {
                  pluginId: "acp-governance",
                  title,
                  description,
                  severity,
                  timeoutMs: 120000,
                  // Explicit, not the runtime default — a call this
                  // client can't get a real answer for must never fall
                  // open.
                  timeoutBehavior: "deny",
                  onResolution: (resolution) => {
                    process.stderr.write(`[ACP] approval ${resolution} for ${event.toolName}\n`);
                  },
                };
                return { requireApproval };
              }
            } catch (err) {
              process.stderr.write(`[ACP] approval setup failed, blocking: ${String(err)}\n`);
              return {
                block: true,
                blockReason: `[ACP] ${result.reason} (approval setup failed)`,
              };
            }
            // No verified approval support on this host: block, and point
            // at where the approval actually lives. Only this path and the
            // spec-build failure above are approvable — a policy deny, an
            // unrecognized verdict, or a fail-closed outage are not, so
            // they must not carry the same instruction.
            return {
              block: true,
              blockReason: `[ACP] ${result.reason} — approve in the ACP console (cloud.agenticcontrolplane.com), then re-run.`,
            };
          }

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
