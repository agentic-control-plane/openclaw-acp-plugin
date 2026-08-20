// Black-box test for the #718 fail-posture bugs: an "ask" verdict must
// never fall open, and every fail-open path must be loud (never silently
// ungoverned). Drives the real registered before_tool_call handler — the
// hook merge shape (block/blockReason, no non-blocking message field) is
// exercised exactly as OpenClaw's runtime would call it.
// Run with: npm test (builds src/ first, then node --test test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dist/plugin.js is CommonJS (`exports.default = ...`); Node's ESM
// interop surfaces that as `module.default.default` rather than
// `module.default`, since the whole `exports` object becomes `.default`.
// Named CJS exports (`exports.__testing = ...`) get hoisted to the top
// level by the same interop, so `pluginModule.__testing` is reachable
// directly.
const pluginModule = await import("../dist/plugin.js");
const plugin = pluginModule.default.default ?? pluginModule.default;
const testing = pluginModule.__testing;

function registeredHandler() {
  let handler;
  plugin.register({
    on(hook, fn) {
      if (hook === "before_tool_call") handler = fn;
    },
  });
  assert.ok(handler, "before_tool_call handler was not registered");
  return handler;
}

const baseEvent = { toolName: "Bash", params: { command: "echo hi" } };

// agentId "main" resolves to the interactive tier; anything else (that
// isn't "unknown") resolves to a non-interactive tier — see
// resolveAgentTier in src/plugin.ts.
const interactiveCtx = { agentId: "main", sessionKey: "s1" };
const backgroundCtx = { agentId: "ops-agent", sessionKey: "s1" };

function fetchJson(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function fetchThrows(err) {
  return async () => {
    throw err;
  };
}

// Vars this suite ever touches. Restored key-by-key below rather than via
// `process.env = snapshot` — a wholesale reassignment breaks process.env's
// live binding to the real OS environment (os.homedir() reads via libuv's
// getenv(), not the JS process.env object), so a later per-key set would
// stop reaching native code silently.
const MANAGED_ENV_KEYS = ["ACP_BEARER_TOKEN", "HOME"];

// approvalSupport controls plugin.ts's hostSupportsRequireApproval() probe:
//   undefined -> leave the real probe in place (this dev environment has no
//                openclaw in node_modules, so it resolves to false — this is
//                what exercises the unsupported-host path below)
//   true/false -> force the branch via the test-only __testing seam
//   a function -> installed as a throwing getter, to simulate the probe
//                 itself blowing up (approval round-trip setup failure)
async function runHook(ctx, fetchImpl, env = {}, approvalSupport = undefined) {
  const handler = registeredHandler();
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  const originalValues = Object.fromEntries(
    MANAGED_ENV_KEYS.map((key) => [key, process.env[key]])
  );
  const originalDescriptor = Object.getOwnPropertyDescriptor(testing, "approvalSupportOverride");
  let stderr = "";

  globalThis.fetch = fetchImpl;
  process.stderr.write = (chunk) => {
    stderr += chunk.toString();
    return true;
  };
  delete process.env.ACP_BEARER_TOKEN;
  for (const key of MANAGED_ENV_KEYS) {
    if (key in env) process.env[key] = env[key];
  }
  if (typeof approvalSupport === "function") {
    Object.defineProperty(testing, "approvalSupportOverride", {
      configurable: true,
      get: approvalSupport,
    });
  } else if (approvalSupport !== undefined) {
    testing.approvalSupportOverride = approvalSupport;
  }

  try {
    const result = await handler(baseEvent, ctx);
    return { result, stderr };
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
    for (const key of MANAGED_ENV_KEYS) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
    Object.defineProperty(testing, "approvalSupportOverride", originalDescriptor);
  }
}

const TOKEN_ENV = { ACP_BEARER_TOKEN: "test-token" };

// Pins the host's verified before_tool_call consumption contract
// (openclaw 2026.4.5, pi-embedded's runBeforeToolCallHook): block is
// checked before requireApproval, so the two are mutually exclusive in
// practice; allow-once/allow-always resolve to allowed, deny resolves to
// blocked, and anything else is gated by timeoutBehavior (defaulting to
// "deny" if unset — this plugin always sets it explicitly). Any drift
// between this and the real host should show up as a test failure here,
// not as a silent behavior change in production.
function mockHostConsumeBeforeToolCall(hookResult, resolution) {
  if (hookResult.block) {
    return { blocked: true, reason: hookResult.blockReason };
  }
  if (!hookResult.requireApproval) {
    return { blocked: false };
  }
  if (resolution === "allow-once" || resolution === "allow-always") {
    return { blocked: false };
  }
  if (resolution === "deny") {
    return { blocked: true, reason: "Denied by user" };
  }
  const timeoutBehavior = hookResult.requireApproval.timeoutBehavior ?? "deny";
  return timeoutBehavior === "deny"
    ? { blocked: true, reason: "Approval timed out" }
    : { blocked: false };
}

test("deny decision blocks with the server's reason", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "deny", reason: "budget exceeded" }),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /budget exceeded/);
});

test("ask decision blocks on an unsupported host (no override; real probe finds no openclaw here) and tells the human what to do", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "ask", reason: "spend over $50 needs approval" }),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /spend over \$50 needs approval/);
});

test("step_up decision fails closed the same way as ask on an unsupported host", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "step_up", reason: "elevated scope required" }),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /elevated scope required/);
});

test("unknown decision values fail closed and name the value", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "quarantine" }),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /unrecognized decision "quarantine"/);
});

test("missing decision field fails closed", async () => {
  const { result } = await runHook(interactiveCtx, fetchJson(200, {}), TOKEN_ENV);
  assert.equal(result.block, true);
  assert.match(result.blockReason, /unrecognized decision/);
});

test("no credentials: interactive tier fails open, loudly", async () => {
  // Redirect readToken()'s file lookup away from the real ~/.acp.
  const home = mkdtempSync(join(tmpdir(), "acp-posture-"));
  const { result, stderr } = await runHook(interactiveCtx, fetchJson(200, {}), { HOME: home });
  assert.equal(result.block, undefined);
  assert.match(stderr, /\[ACP\]/);
  assert.match(stderr, /UNGOVERNED/);
});

test("no credentials: background tier fails closed, loudly", async () => {
  const home = mkdtempSync(join(tmpdir(), "acp-posture-"));
  const { result, stderr } = await runHook(backgroundCtx, fetchJson(200, {}), { HOME: home });
  assert.equal(result.block, true);
  assert.match(result.blockReason, /fail-closed/);
  assert.match(stderr, /\[ACP\]/);
});

test("HTTP error: interactive tier fails open, loudly", async () => {
  const { result, stderr } = await runHook(
    interactiveCtx,
    fetchJson(503, { error: "unavailable" }),
    TOKEN_ENV
  );
  assert.equal(result.block, undefined);
  assert.match(stderr, /HTTP 503/);
  assert.match(stderr, /UNGOVERNED/);
});

test("HTTP error: background tier fails closed, loudly", async () => {
  const { result, stderr } = await runHook(
    backgroundCtx,
    fetchJson(503, { error: "unavailable" }),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /HTTP 503/);
  assert.match(stderr, /\[ACP\]/);
});

test("network error: interactive tier fails open, loudly", async () => {
  const { result, stderr } = await runHook(
    interactiveCtx,
    fetchThrows(new Error("getaddrinfo ENOTFOUND")),
    TOKEN_ENV
  );
  assert.equal(result.block, undefined);
  assert.match(stderr, /network error/);
  assert.match(stderr, /UNGOVERNED/);
});

test("network error: background tier fails closed, loudly", async () => {
  const { result, stderr } = await runHook(
    backgroundCtx,
    fetchThrows(new Error("getaddrinfo ENOTFOUND")),
    TOKEN_ENV
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /network error/);
  assert.match(stderr, /\[ACP\]/);
});

test("timeout (abort) is reported distinctly and follows the same tier posture", async () => {
  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  const { result, stderr } = await runHook(backgroundCtx, fetchThrows(abortErr), TOKEN_ENV);
  assert.equal(result.block, true);
  assert.match(result.blockReason, /timed out/);
  assert.match(stderr, /\[ACP\]/);
});

test("allow decision passes through silently", async () => {
  const { result, stderr } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "allow" }),
    TOKEN_ENV
  );
  assert.deepEqual(result, {});
  assert.equal(stderr, "");
});

test("ask decision on a host that supports requireApproval opens an approval instead of blocking", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "ask", reason: "spend over $50 needs approval" }),
    TOKEN_ENV,
    true
  );
  assert.equal(result.block, undefined);
  assert.ok(result.requireApproval, "expected a requireApproval object");
  assert.equal(result.requireApproval.pluginId, "acp-governance");
  assert.match(result.requireApproval.title, /Bash/);
  assert.match(result.requireApproval.description, /spend over \$50 needs approval/);
  assert.match(result.requireApproval.description, /ACP policy/);
  // Never rely on the host's default — a call we can't get a real answer
  // for must never fall open.
  assert.equal(result.requireApproval.timeoutBehavior, "deny");
  assert.equal(typeof result.requireApproval.timeoutMs, "number");
  assert.equal(typeof result.requireApproval.onResolution, "function");
});

test("ask maps to warning severity, step_up maps to critical", async () => {
  const ask = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "ask", reason: "needs approval" }),
    TOKEN_ENV,
    true
  );
  assert.equal(ask.result.requireApproval.severity, "warning");

  const stepUp = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "step_up", reason: "elevated scope required" }),
    TOKEN_ENV,
    true
  );
  assert.equal(stepUp.result.requireApproval.severity, "critical");
});

test("description flags when the gateway already opened its own ACP-side approval", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, {
      decision: "step_up",
      reason: "approval-requested: elevated scope required",
    }),
    TOKEN_ENV,
    true
  );
  assert.match(result.requireApproval.description, /already exists/);
  assert.match(result.requireApproval.description, /cloud\.agenticcontrolplane\.com/);
  assert.match(result.requireApproval.description, /asked twice/);
});

test("description stays plain when no ACP-side approval already exists", async () => {
  const { result } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "ask", reason: "spend over $50 needs approval" }),
    TOKEN_ENV,
    true
  );
  assert.doesNotMatch(result.requireApproval.description, /already exists/);
});

// Every resolution the host's PluginApprovalResolutions enum can produce,
// run through the pinned host-consumption contract above. Only the two
// allow-* resolutions should ever let the call through.
const RESOLUTIONS = ["allow-once", "allow-always", "deny", "timeout", "cancelled"];
const ALLOWING_RESOLUTIONS = new Set(["allow-once", "allow-always"]);

for (const resolution of RESOLUTIONS) {
  test(`resolution "${resolution}" ${ALLOWING_RESOLUTIONS.has(resolution) ? "allows" : "blocks"} the call`, async () => {
    const { result } = await runHook(
      interactiveCtx,
      fetchJson(200, { decision: "ask", reason: "needs approval" }),
      TOKEN_ENV,
      true
    );
    const outcome = mockHostConsumeBeforeToolCall(result, resolution);
    assert.equal(outcome.blocked, !ALLOWING_RESOLUTIONS.has(resolution));
  });

  test(`onResolution logs "${resolution}" to stderr`, async () => {
    const { result, stderr: setupStderr } = await runHook(
      interactiveCtx,
      fetchJson(200, { decision: "ask", reason: "needs approval" }),
      TOKEN_ENV,
      true
    );
    let logged = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      logged += chunk.toString();
      return true;
    };
    try {
      result.requireApproval.onResolution(resolution);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(setupStderr, "");
    assert.match(logged, new RegExp(`\\[ACP\\] approval ${resolution} for Bash`));
  });
}

test("an error while building the approval falls back to a hard block, not an open call", async () => {
  const { result, stderr } = await runHook(
    interactiveCtx,
    fetchJson(200, { decision: "ask", reason: "needs approval" }),
    TOKEN_ENV,
    () => {
      throw new Error("probe blew up");
    }
  );
  assert.equal(result.block, true);
  assert.equal(result.requireApproval, undefined);
  assert.match(result.blockReason, /needs approval/);
  assert.match(result.blockReason, /approval setup failed/);
  assert.match(stderr, /\[ACP\] approval setup failed, blocking/);
});
