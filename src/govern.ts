import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getApiBase, readToken } from "./credentials.js";

export const PLUGIN_VERSION = "0.2.1";

export const KEY_REJECTED_FIX =
  "Fix: re-run the installer (curl -sf https://agenticcontrolplane.com/install.sh | bash) or create a key at https://cloud.agenticcontrolplane.com/settings/api-keys and save it: echo 'gsk_...' > ~/.acp/credentials";
export const WORKSPACE_DELETED_FIX =
  "The ACP workspace this machine was connected to has been deleted. To remove ACP from this machine: acp-uninstall (older installs without it: curl -sf https://agenticcontrolplane.com/uninstall.sh | bash). To keep using ACP, re-run the installer: curl -sf https://agenticcontrolplane.com/install.sh | bash";

const DELETED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function lapseLine(fields: Record<string, unknown>): void {
  try {
    mkdirSync(join(homedir(), ".acp"), { recursive: true });
    appendFileSync(
      join(homedir(), ".acp", "lapse.log"),
      `${JSON.stringify({ at: new Date().toISOString(), client: "openclaw-plugin", ...fields })}\n`,
    );
  } catch {
    /* the lapse log is best-effort — never block a call on it */
  }
}

/**
 * True the first time the workspace-deleted notice is asked for in a session,
 * false after (marker ~/.acp/notices/workspace-deleted.<session>, created with
 * the `wx` flag — shared with the other ACP harness plugins on this machine).
 * With no session id, at most once per 24h via a timestamp marker. Fails
 * toward showing: an unwritable marker repeats, never vanishes.
 */
export function firstDeletedNotice(sessionId: string | undefined, now = Date.now()): boolean {
  const dir = join(homedir(), ".acp", "notices");
  const id = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  try {
    mkdirSync(dir, { recursive: true });
    if (!id || id === "unknown") {
      const marker = join(dir, "workspace-deleted.no-session");
      let last = 0;
      try {
        last = Date.parse(readFileSync(marker, "utf8").trim()) || 0;
      } catch {
        /* absent */
      }
      if (now - last < DELETED_NOTICE_WINDOW_MS) return false;
      writeFileSync(marker, new Date(now).toISOString());
      return true;
    }
    writeFileSync(join(dir, `workspace-deleted.${id}`), new Date(now).toISOString(), { flag: "wx" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "EEXIST";
  }
}

export type GovernResult = {
  allowed: boolean;
  decision: string;
  reason: string;
  // Set when this verdict came from an infrastructure failure (no
  // credentials, HTTP error, network error/timeout) rather than a real
  // policy answer. The caller must surface `reason` to the user regardless
  // of `allowed` — see plugin.ts.
  ungoverned?: boolean;
};

/**
 * Call ACP's governance endpoint and return a verdict.
 *
 * Policy decisions map as follows:
 *   allow              → allowed
 *   deny               → blocked, server's reason
 *   ask / step_up      → not allowed, raw server reason returned as-is.
 *                        plugin.ts decides how to surface this: OpenClaw's
 *                        requireApproval primitive when the host supports
 *                        it, otherwise a hard block telling the human to
 *                        approve in the ACP console and re-run.
 *   anything else       → blocked (unrecognized/missing decision — a verdict
 *                        this client can't interpret must never fall open)
 *
 * Infrastructure failures (no credentials / non-2xx / network error) fail
 * open on the interactive tier only — an ACP outage must not freeze a
 * session with a human watching it. Unattended tiers (subagent, background,
 * api) have nobody to notice a silent lapse, so they fail closed instead.
 * Every failure path is loud either way (`ungoverned: true` + a reason the
 * caller must surface) — fail-open is never fail-open-silent.
 */
export async function checkAcpGovernance(opts: {
  toolName: string;
  toolInput: string;
  agentId: string;
  sessionKey?: string;
  agentTier?: string;
  // #1518: the host's runtime probe for whether its approval service is
  // present (PluginApprovalResolutions). Sent only on the PreToolUse call.
  // When true, the plugin renders a native approval prompt on "ask".
  approvalServiceAvailable?: boolean;
}): Promise<GovernResult> {
  const tier = opts.agentTier || "interactive";
  const failsOpen = tier === "interactive";

  function outage(code: string, detail: string): GovernResult {
    if (failsOpen) {
      return {
        allowed: true,
        decision: code,
        reason: `${detail} — this call ran UNGOVERNED (no policy check, no audit record).`,
        ungoverned: true,
      };
    }
    return {
      allowed: false,
      decision: code,
      reason: `${detail} — blocked (fail-closed for "${tier}" tier; unattended agents never run ungoverned).`,
      ungoverned: true,
    };
  }

  // A 401/403 is NOT the gateway being down — it is this machine's key being
  // revoked, mistyped, or from a deleted workspace. Reading it as "gateway
  // returned HTTP 401" left a user running ungoverned believing it was our
  // outage. Same tier posture as an outage (interactive fails open,
  // unattended stays blocked), but the message names the cause and the fix.
  // `code: "workspace_deleted"`: the owner deleted the workspace on purpose —
  // say so once per session with how to remove ACP, then proceed silently
  // (the lapse is still logged). (gatewaystack-connect#1693, ported from
  // codex-acp-plugin / pi-acp-plugin.)
  function keyRejected(status: number, code: string | undefined): GovernResult {
    const deleted = code === "workspace_deleted";
    const fix = deleted ? WORKSPACE_DELETED_FIX : KEY_REJECTED_FIX;
    if (failsOpen) {
      lapseLine({ kind: "UNGOVERNED", tool: opts.toolName, tier, detail: `key rejected (HTTP ${status})` });
      if (deleted && !firstDeletedNotice(opts.sessionKey)) {
        return { allowed: true, decision: "acp-key-rejected", reason: "workspace deleted (notice already shown)" };
      }
      return {
        allowed: true,
        decision: "acp-key-rejected",
        reason: `⚠ KEY REJECTED (HTTP ${status}): the key in ~/.acp/credentials is revoked or invalid — this call proceeded UNGOVERNED and unlogged, and every call will until it is fixed. ${fix}`,
        ungoverned: true,
      };
    }
    return {
      allowed: false,
      decision: "acp-key-rejected",
      reason: `Key rejected (HTTP ${status}) — the key in ~/.acp/credentials is revoked or invalid; ${tier} tier stays blocked until it is fixed. ${fix}`,
      ungoverned: true,
    };
  }

  const token = readToken();
  if (!token) {
    return outage("no-acp-credentials", "no ACP credentials found at ~/.acp/credentials");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`${getApiBase()}/govern/tool-use`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GS-Client": `openclaw-acp-plugin/${PLUGIN_VERSION}`,
      },
      body: JSON.stringify({
        tool_name: opts.toolName,
        tool_input: opts.toolInput.slice(0, 2000),
        session_id: opts.sessionKey,
        agent_tier: tier,
        client: { name: "OpenClaw", version: "0.1.0" },
        // #1518: positive claim only from the runtime probe; false is a
        // positive "nobody will see a dialog" and always wins at the gateway.
        ...(typeof opts.approvalServiceAvailable === "boolean"
          ? {
              attended: { claim: opts.approvalServiceAvailable, source: "approval-service" },
              ...(opts.approvalServiceAvailable ? { capabilities: ["native_ask"] } : {}),
            }
          : {}),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 401 || res.status === 403) {
      let code: string | undefined;
      try {
        const errBody = (await res.json()) as { code?: unknown } | null;
        if (typeof errBody?.code === "string") code = errBody.code;
      } catch {
        /* empty or non-JSON body — still a key rejection */
      }
      return keyRejected(res.status, code);
    }

    if (!res.ok) {
      return outage("acp-http-error", `ACP gateway returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      decision?: string;
      reason?: string;
    };

    switch (data.decision) {
      case "allow":
        return { allowed: true, decision: "allow", reason: data.reason || "allow" };

      case "deny":
        return { allowed: false, decision: "deny", reason: data.reason || "denied by policy" };

      case "ask":
      case "step_up":
        // Raw reason, no wording bolted on — plugin.ts composes the
        // human-facing message differently depending on whether it can
        // route this through requireApproval or has to fall back to a
        // hard block, and needs the unmodified string to detect when the
        // server already opened an ACP-side approval (reason prefixed
        // "approval-requested:" / "approval-pending:").
        return {
          allowed: false,
          decision: data.decision,
          reason: data.reason || "requires approval",
        };

      default:
        // Unrecognized or missing decision — never fall open on a verdict
        // this client doesn't understand.
        return {
          allowed: false,
          decision: data.decision ?? "undefined",
          reason: `unrecognized decision "${data.decision}" — update @agenticcontrolplane/openclaw to the latest version`,
        };
    }
  } catch (err) {
    clearTimeout(timeout);
    const detail =
      err instanceof Error && err.name === "AbortError" ? "timed out after 4s" : "network error";
    return outage("acp-network-error", `ACP gateway unreachable (${detail})`);
  } finally {
    clearTimeout(timeout);
  }
}
