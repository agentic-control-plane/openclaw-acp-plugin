import { getApiBase, readToken } from "./credentials.js";

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
        "X-GS-Client": "openclaw-acp-plugin/0.1.1",
      },
      body: JSON.stringify({
        tool_name: opts.toolName,
        tool_input: opts.toolInput.slice(0, 2000),
        session_id: opts.sessionKey,
        agent_tier: tier,
        client: { name: "OpenClaw", version: "0.1.0" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

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
