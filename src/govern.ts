import { getApiBase, readToken } from "./credentials.js";

export type GovernResult = {
  allowed: boolean;
  decision: "allow" | "deny" | "ask";
  reason: string;
};

/**
 * Call ACP's governance endpoint. Returns allow/deny decision.
 * Fails open on any error — never breaks the agent.
 */
export async function checkAcpGovernance(opts: {
  toolName: string;
  toolInput: string;
  agentId: string;
  sessionKey?: string;
  agentTier?: string;
}): Promise<GovernResult> {
  const token = readToken();
  if (!token) {
    return { allowed: true, decision: "allow", reason: "no-acp-credentials" };
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
        agent_tier: opts.agentTier || "interactive",
        client: { name: "OpenClaw", version: "0.1.0" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { allowed: true, decision: "allow", reason: "acp-http-error" };
    }

    const data = (await res.json()) as {
      decision: string;
      reason?: string;
    };

    // Only an explicit "allow" proceeds. OpenClaw's hook API has no ask
    // primitive, so an "ask" verdict blocks with the approval reason — the
    // server fail-closes unconsumed step_up the same way. Unknown decision
    // values also block: a verdict this client doesn't understand must not
    // fall open (the pre-#444 "ask" bug class).
    if (data.decision === "allow") {
      return { allowed: true, decision: "allow", reason: data.reason || "allow" };
    }
    if (data.decision === "ask") {
      return {
        allowed: false,
        decision: "ask",
        reason: data.reason || "requires approval — approve in the ACP console, then retry",
      };
    }
    return {
      allowed: false,
      decision: "deny",
      reason: data.reason || data.decision || "denied by policy",
    };
  } catch {
    return { allowed: true, decision: "allow", reason: "acp-network-error" };
  } finally {
    clearTimeout(timeout);
  }
}
