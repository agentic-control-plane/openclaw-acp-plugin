// #1518: attended signal on PreToolUse. claim comes from the runtime probe
// (PluginApprovalResolutions), source is "approval-service", native_ask only
// when the approval service is present. PostToolUse is never sent by this plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "acp-openclaw-att-"));
mkdirSync(join(home, ".acp"), { recursive: true });
writeFileSync(join(home, ".acp", "credentials"), "test-token\n");
process.env.HOME = home;

const { checkAcpGovernance } = await import("../dist/govern.js");
const pluginModule = await import("../dist/plugin.js");
const plugin = pluginModule.default.default ?? pluginModule.default;
const __testing = pluginModule.__testing;

function capture() {
  const bodies = [];
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ decision: "allow" }), { status: 200 });
  };
  return bodies;
}
const CALL = { toolName: "Bash", toolInput: "{}", agentId: "a1" };

test("approval service present: claim true, source approval-service, native_ask", async () => {
  const b = capture();
  await checkAcpGovernance({ ...CALL, approvalServiceAvailable: true });
  assert.deepEqual(b[0].attended, { claim: true, source: "approval-service" });
  assert.deepEqual(b[0].capabilities, ["native_ask"]);
});

test("approval service absent: claim false, no native_ask", async () => {
  const b = capture();
  await checkAcpGovernance({ ...CALL, approvalServiceAvailable: false });
  assert.deepEqual(b[0].attended, { claim: false, source: "approval-service" });
  assert.equal(b[0].capabilities, undefined);
});

test("no probe result: nothing sent", async () => {
  const b = capture();
  await checkAcpGovernance(CALL);
  assert.equal(b[0].attended, undefined);
  assert.equal(b[0].capabilities, undefined);
});

test("plugin hook sends the probe result, not the agent tier", async () => {
  process.env.ACP_AGENT_TIER = "interactive";
  let handler;
  plugin.register({ on: (_n, fn) => { handler = fn; } });
  for (const supported of [true, false]) {
    __testing.approvalSupportOverride = supported;
    const b = capture();
    await handler({ toolName: "Bash", params: {} }, { agentId: "a1", sessionKey: "s" });
    assert.equal(b[0].attended.claim, supported);
  }
  delete process.env.ACP_AGENT_TIER;
  __testing.approvalSupportOverride = undefined;
});

test("no PostToolUse path sends attended/native_ask", () => {
  const src = readFileSync(new URL("../src/govern.ts", import.meta.url), "utf8");
  assert.equal((src.match(/\/govern\//g) ?? []).length, 1, "only the tool-use endpoint is called");
});
