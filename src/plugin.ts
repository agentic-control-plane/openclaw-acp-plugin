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
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  modelProviderId?: string;
  modelId?: string;
  // What started this turn: "user", "cron", "heartbeat", "memory" ...
  trigger?: string;
  channelId?: string;
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

// The host's before_tool_call `requireApproval` shape (OpenClaw 2026.11.x).
// There is no timeout-behaviour field: a timeout always blocks, and
// `timeoutReason` only sets the text shown.
type RequireApprovalSpec = {
  title: string;
  description: string;
  scope?: string;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
  timeoutReason?: string;
  allowedDecisions?: ("allow-once" | "allow-always" | "deny")[];
  pluginId?: string;
  onResolution?: (resolution: PluginApprovalResolution) => void;
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
const APPROVAL_TIMEOUT_MS = 120000;

// Only one-time answers. Whether the host remembers allow-always for plugin
// approvals is unconfirmed; if it did, a later gateway ask would run unasked.
const ALLOWED_DECISIONS: ("allow-once" | "deny")[] = ["allow-once", "deny"];

const APPROVAL_TIMEOUT_REASON =
  "[ACP] Nobody answered the approval prompt in 2 minutes, so the call was not run.";

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
  const title = truncate(`ACP asks: ${params.toolName}`, APPROVAL_TITLE_MAX);
  // The gateway's reason comes first and unchanged; it is cut only if it
  // alone exceeds the limit. The note is added only when the whole text
  // still fits.
  const existingApprovalNote =
    "An ACP approval for this call already exists at cloud.agenticcontrolplane.com — approving here does not resolve it, so you may be asked twice for the same call.";
  const withNote = `${params.reason}\n\n${existingApprovalNote}`;
  const description =
    alreadyInAcp && withNote.length <= APPROVAL_DESCRIPTION_MAX
      ? withNote
      : truncate(params.reason, APPROVAL_DESCRIPTION_MAX);
  // step_up is the higher bar — an elevated-scope requirement, not just a
  // policy threshold — so it gets the top severity band.
  const severity = params.decision === "step_up" ? "critical" : "warning";
  return { title, description, severity };
}

// A trigger is sent to the gateway and shown in the block text (which goes
// back to the agent) only when it is a plain lowercase word. Anything else,
// including control, bidi or zero-width characters, a broken surrogate or
// sentence text, becomes the fixed word "unknown".
const SAFE_TRIGGER = /^[a-z0-9_-]{1,32}$/;
const UNSAFE_TRIGGER_WORD = "unknown";

function safeTrigger(trigger: string): string {
  return SAFE_TRIGGER.test(trigger) ? trigger : UNSAFE_TRIGGER_WORD;
}

// OpenClaw gives subagent runs session keys of the form
// `agent:<agentId>:subagent:<uuid>`, even when the parent is `main`.
function isSubagentSession(sessionKey: unknown): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

// A person can be asked only when the host can show a plugin approval, the
// turn was started by a user (the host itself blocks a plugin approval on
// cron, heartbeat or memory turns), the agent id is exactly `main`, and the
// session is not a subagent run. Every hook-context field is optional on the
// host, so a missing trigger or agent id is never a claim. `why` explains a
// false claim in the block text.
function computeAttended(params: {
  hostSupports: boolean;
  trigger: string | undefined;
  agentId: string | undefined;
  sessionKey: unknown;
}): { claim: boolean; mode: string; why: string } {
  const shown = params.trigger === undefined ? undefined : safeTrigger(params.trigger);
  const mode = shown ?? "none";
  if (!params.hostSupports) {
    return { claim: false, mode, why: "this OpenClaw build has no approval prompt" };
  }
  if (params.trigger !== "user") {
    return {
      claim: false,
      mode,
      why: shown
        ? `this turn was started by ${shown}, not by a person`
        : "this turn was not started by a person",
    };
  }
  if (params.agentId === undefined) {
    return { claim: false, mode, why: "this call has no agent id, so it cannot be tied to the main agent" };
  }
  if (params.agentId !== "main") {
    return { claim: false, mode, why: "this call came from a subagent, not the main agent" };
  }
  if (isSubagentSession(params.sessionKey)) {
    return { claim: false, mode, why: "this call came from a subagent run, not the main agent" };
  }
  return { claim: true, mode, why: "" };
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
        const agentTier = resolveAgentTier(agentId);
        let hostSupports = false;
        let probeError: unknown = undefined;
        let probeFailed = false;
        try {
          hostSupports = hostSupportsRequireApproval() === true;
        } catch (err) {
          // a probe that throws is not a claim of attendance
          probeFailed = true;
          probeError = err;
        }
        const trigger = typeof ctx.trigger === "string" && ctx.trigger ? ctx.trigger : undefined;
        // The claim reads the raw agent id; the "unknown" fallback above
        // only sets the outage posture, never a claim of a person.
        const attended = computeAttended({
          hostSupports,
          trigger,
          agentId: typeof ctx.agentId === "string" ? ctx.agentId : undefined,
          sessionKey: ctx.sessionKey,
        });
        const result = await checkAcpGovernance({
          toolName: event.toolName,
          toolInput: JSON.stringify(event.params),
          agentId,
          sessionKey: ctx.sessionKey,
          agentTier,
          attended: { claim: attended.claim, mode: attended.mode },
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
              if (probeFailed) throw probeError;
              // Only the claim sent to the gateway opens a prompt: the
              // same answer both sides act on.
              if (attended.claim) {
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
                  timeoutMs: APPROVAL_TIMEOUT_MS,
                  // A timeout always blocks on the host; this only sets
                  // the text.
                  timeoutReason: APPROVAL_TIMEOUT_REASON,
                  allowedDecisions: [...ALLOWED_DECISIONS],
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
            // Nobody can be asked here: block, say why, and show the
            // gateway's own text (with its console link) unchanged. Only
            // this path and the spec-build failure above are approvable —
            // a policy deny, an unrecognized verdict, or a fail-closed
            // outage are not, so they must not carry the same instruction.
            return {
              block: true,
              blockReason: `[ACP] This call needs a person's approval and OpenClaw cannot ask here (${attended.why}), so it is blocked. Approve it in the ACP console, then run it again.\n\n${result.reason}`,
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
