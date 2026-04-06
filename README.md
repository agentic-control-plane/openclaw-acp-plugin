# Agentic Control Plane — OpenClaw Plugin

Identity, governance, and audit for every OpenClaw tool call.

When active, every tool call your OpenClaw agent makes — `read`, `write`, `exec`, `web_search`, and all custom tools — is logged to your ACP workspace. Set policies to control what's allowed. Get full compliance visibility across your team.

ACP doesn't replace your tools or change how you use OpenClaw. It's the governance layer that sits transparently in front of everything.

## One-command install

```bash
curl -sf https://agenticcontrolplane.com/install-openclaw.sh | bash
```

This installs the plugin, opens your browser to sign up / log in, provisions your workspace, and activates the governance hook. You'll land on your audit log dashboard — done.

Or install manually:

```bash
openclaw plugins install @gatewaystack/acp-governance
```

## How it works

The plugin registers a `before_tool_call` hook that fires before every tool execution:

1. Hook sends tool name + input to ACP's governance API
2. ACP evaluates policies (agent tier, tool rules, rate limits, content scanning)
3. Returns `allow` or `deny`
4. All calls are logged to your workspace's audit trail

The hook **fails open** on network errors — ACP outages never break your agent.

## What you get

- **Audit logs** — every tool call with identity, arguments, timestamps, decisions
- **Policy enforcement** — allow/deny by agent tier, tool name, argument patterns
- **Rate limits & budgets** — cap tool calls per minute, per month, or by cost
- **Content scanning** — detect PII in tool inputs, optionally block or redact
- **Team management** — multiple members, roles, workspace-level controls

## Dashboard

After setup, your dashboard is at:

- **Activity**: `https://cloud.agenticcontrolplane.com/activity`
- **Policies**: `https://cloud.agenticcontrolplane.com/policies`
- **Team**: `https://cloud.agenticcontrolplane.com/team`

## Agent tier mapping

OpenClaw agent IDs map to ACP governance tiers:

| Agent ID | ACP Tier | Default policy |
|---|---|---|
| `main` | Interactive | Permissive — primary user agent |
| Named agents (e.g. `ops`, `dev`) | Subagent | Moderate — spawned for tasks |

## Pause / disable

```bash
# Pause governance (keep credentials)
mv ~/.acp/credentials ~/.acp/credentials.paused

# Resume
mv ~/.acp/credentials.paused ~/.acp/credentials

# Fully remove
rm -rf ~/.acp
openclaw plugins uninstall acp-governance
```

## Support

- Site: https://agenticcontrolplane.com
- Issues: https://github.com/gatewaystack/openclaw-acp-plugin/issues
