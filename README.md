# Agentic Control Plane: OpenClaw Plugin

Checks every OpenClaw tool call against your Agentic Control Plane rules before it runs, and logs it. That covers `read`, `write`, `exec`, `web_search` and all custom tools. Calls are logged to your ACP workspace, and the plugin needs a workspace key.

## One-command install

```bash
curl -sf https://agenticcontrolplane.com/install-openclaw.sh | bash
```

This installs the plugin, opens your browser to sign up or log in, provisions your workspace, and activates the hook. You land on your audit log dashboard.

Or install manually:

```bash
openclaw plugins install @agenticcontrolplane/openclaw
```

The main installer (`curl -sf https://agenticcontrolplane.com/install.sh | bash`) also installs this plugin when it finds `openclaw` on your machine.

## How it works

The plugin registers a `before_tool_call` hook that fires before every tool execution:

1. The hook sends the tool name and input to ACP's governance API.
2. ACP evaluates the safety floor and your policies (agent tier, tool rules, rate limits, content scanning).
3. It returns `allow`, `ask` or `deny`. Today the gateway sends a hold as a prompt only to Claude Code, so in OpenClaw an `ask` is blocked with an approval link: approve on the console or from the email, then retry. The plugin can render OpenClaw's own prompt once the gateway sends asks to OpenClaw.
4. All calls are logged to your workspace's audit trail.

If ACP is unreachable, calls from the `main` agent proceed with an UNGOVERNED warning. Calls from named agents (the subagent tier) are blocked until ACP answers. If hooks are switched off, nothing is checked.

## What you get

- **Audit logs:** every tool call with identity, arguments, timestamps and decisions.
- **Policy enforcement:** allow, ask or deny by agent tier, tool name and argument patterns.
- **Rate limits and budgets:** cap tool calls per minute, per month, or by cost.
- **Content scanning:** detect PII in tool inputs, optionally block or redact.
- **Team management:** multiple members, roles and workspace-level controls.

## Dashboard

After setup, your dashboard is at:

- **Activity**: `https://cloud.agenticcontrolplane.com/activity`
- **Policies**: `https://cloud.agenticcontrolplane.com/policies`
- **Team**: `https://cloud.agenticcontrolplane.com/team`

## Agent tier mapping

OpenClaw agent IDs map to ACP governance tiers:

| Agent ID | ACP Tier | Default policy |
|---|---|---|
| `main` | Interactive | Permissive; the primary user agent |
| Named agents (e.g. `ops`, `dev`) | Subagent | Moderate; spawned for tasks |

## Pause / disable

```bash
# Pause governance (keep credentials)
mv ~/.acp/credentials ~/.acp/credentials.paused

# Resume
mv ~/.acp/credentials.paused ~/.acp/credentials

# Fully remove
rm -rf ~/.acp
openclaw plugins uninstall @agenticcontrolplane/openclaw
```

## Support

- Site: https://agenticcontrolplane.com
- Issues: https://github.com/agentic-control-plane/openclaw-acp-plugin/issues
