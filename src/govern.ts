import { getApiBase, readToken } from "./credentials.js";

export type GovernResult = {
  allowed: boolean;
  decision: "allow" | "deny";
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

    return {
      allowed: data.decision !== "deny",
      decision: data.decision as "allow" | "deny",
      reason: data.reason || data.decision,
    };
  } catch {
    return { allowed: true, decision: "allow", reason: "acp-network-error" };
  } finally {
    clearTimeout(timeout);
  }
}
