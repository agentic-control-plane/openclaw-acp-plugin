// Verdict-handling conformance (#718 in gatewaystack-connect): only an
// explicit "allow" proceeds. "ask" blocks (OpenClaw has no ask primitive —
// matches the server's fail-closed step_up wire decision), "deny" blocks,
// and UNKNOWN decision values block — a verdict this client doesn't
// understand must never fall open. Infra failures keep the documented
// fail-open posture.
// Run with: npm test  (builds, then node --test test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Throwaway HOME with credentials so readToken() finds a token and the
// govern call actually runs (never touches the real ~/.acp).
const home = mkdtempSync(join(tmpdir(), "acp-openclaw-"));
mkdirSync(join(home, ".acp"), { recursive: true });
writeFileSync(join(home, ".acp", "credentials"), "test-token\n");
process.env.HOME = home;

const { checkAcpGovernance } = await import("../dist/govern.js");

function withDecision(body) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const CALL = { toolName: "Bash", toolInput: '{"command":"ls"}', agentId: "a1" };

test("allow proceeds", async () => {
  withDecision({ decision: "allow", reason: "allowed by policy" });
  const r = await checkAcpGovernance(CALL);
  assert.equal(r.allowed, true);
});

test("deny blocks", async () => {
  withDecision({ decision: "deny", reason: "denied by policy" });
  const r = await checkAcpGovernance(CALL);
  assert.equal(r.allowed, false);
  assert.equal(r.decision, "deny");
});

test("ask blocks with the approval reason (no ask primitive in OpenClaw)", async () => {
  withDecision({ decision: "ask", reason: "step_up by background tier policy" });
  const r = await checkAcpGovernance(CALL);
  assert.equal(r.allowed, false);
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /step_up/);
});

test("unknown decision values fail closed", async () => {
  withDecision({ decision: "quarantine" });
  const r = await checkAcpGovernance(CALL);
  assert.equal(r.allowed, false);
});

test("network error keeps the documented fail-open posture", async () => {
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const r = await checkAcpGovernance(CALL);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "acp-network-error");
});
