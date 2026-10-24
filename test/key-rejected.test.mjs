// A 401/403 from the gateway is a credential failure, not an outage, and a
// 4xx with `code: "workspace_deleted"` says so once per session
// (gatewaystack-connect#1693; mirrors codex-acp-plugin and pi-acp-plugin
// test/key-rejected). Drives the real registered before_tool_call handler.
// Run with: npm test (builds src/ first, then node --test test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pluginModule = await import("../dist/plugin.js");
const plugin = pluginModule.default.default ?? pluginModule.default;

function registeredHandler() {
  let handler;
  plugin.register({
    on(hook, fn) {
      if (hook === "before_tool_call") handler = fn;
    },
  });
  return handler;
}

const baseEvent = { toolName: "Bash", params: { command: "echo hi" } };
const interactive = (sessionKey) => ({ agentId: "main", sessionKey });
const background = (sessionKey) => ({ agentId: "ops-agent", sessionKey });

function fetchJson(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  });
}

const MANAGED_ENV_KEYS = ["ACP_BEARER_TOKEN", "HOME"];

async function runHook(ctx, fetchImpl, home) {
  const handler = registeredHandler();
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  const originalValues = Object.fromEntries(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]));
  let stderr = "";
  globalThis.fetch = fetchImpl;
  process.stderr.write = (chunk) => {
    stderr += chunk.toString();
    return true;
  };
  process.env.ACP_BEARER_TOKEN = "test-token";
  process.env.HOME = home;
  try {
    const result = await handler(baseEvent, ctx);
    return { result, stderr };
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
    for (const k of MANAGED_ENV_KEYS) {
      if (originalValues[k] === undefined) delete process.env[k];
      else process.env[k] = originalValues[k];
    }
  }
}

const tmpHome = () => mkdtempSync(join(tmpdir(), "acp-keyrej-"));
const DELETED = { error: "workspace deleted", code: "workspace_deleted" };

test("interactive 401 proceeds with KEY REJECTED naming the key and the fix, and logs the lapse", async () => {
  const home = tmpHome();
  const { result, stderr } = await runHook(interactive("s1"), fetchJson(401, { error: "invalid key" }), home);
  assert.equal(result.block, undefined);
  assert.match(stderr, /^\[ACP\] ⚠ KEY REJECTED \(HTTP 401\): the key in ~\/\.acp\/credentials is revoked or invalid — this call proceeded UNGOVERNED and unlogged/);
  assert.match(stderr, /install\.sh/);
  assert.match(stderr, /settings\/api-keys/);
  assert.doesNotMatch(stderr, /unreachable|returned HTTP/i);
  assert.match(readFileSync(join(home, ".acp", "lapse.log"), "utf8"), /key rejected \(HTTP 401\)/);
});

test("interactive 401 with no body still reads as KEY REJECTED", async () => {
  const { result, stderr } = await runHook(interactive("s1"), fetchJson(401, undefined), tmpHome());
  assert.equal(result.block, undefined);
  assert.match(stderr, /KEY REJECTED \(HTTP 401\)/);
});

test("unattended 401 stays blocked with the cause named", async () => {
  const { result } = await runHook(background("s1"), fetchJson(401, { error: "invalid key" }), tmpHome());
  assert.equal(result.block, true);
  assert.match(result.blockReason, /^\[ACP\] Key rejected \(HTTP 401\) — the key in ~\/\.acp\/credentials is revoked or invalid/);
  assert.doesNotMatch(result.blockReason, /unreachable|returned HTTP/i);
});

test("403 is treated like 401", async () => {
  const i = await runHook(interactive("s1"), fetchJson(403, { error: "forbidden" }), tmpHome());
  assert.equal(i.result.block, undefined);
  assert.match(i.stderr, /KEY REJECTED \(HTTP 403\)/);
  const u = await runHook(background("s1"), fetchJson(403, { error: "forbidden" }), tmpHome());
  assert.equal(u.result.block, true);
  assert.match(u.result.blockReason, /Key rejected \(HTTP 403\)/);
});

test("5xx keeps the outage posture", async () => {
  const i = await runHook(interactive("s1"), fetchJson(503, { error: "down" }), tmpHome());
  assert.equal(i.result.block, undefined);
  assert.match(i.stderr, /HTTP 503/);
  assert.doesNotMatch(i.stderr, /KEY REJECTED/);
  const u = await runHook(background("s1"), fetchJson(503, { error: "down" }), tmpHome());
  assert.equal(u.result.block, true);
  assert.match(u.result.blockReason, /HTTP 503/);
});

test("interactive workspace_deleted: one notice per session, then silent; lapse logged every call", async () => {
  const home = tmpHome();
  const first = await runHook(interactive("sess-a"), fetchJson(401, DELETED), home);
  assert.equal(first.result.block, undefined);
  assert.match(first.stderr, /workspace this machine was connected to has been deleted/);
  assert.match(first.stderr, /acp-uninstall/);
  assert.match(first.stderr, /uninstall\.sh/);
  assert.ok(existsSync(join(home, ".acp", "notices", "workspace-deleted.sess-a")));

  const second = await runHook(interactive("sess-a"), fetchJson(401, DELETED), home);
  assert.equal(second.result.block, undefined);
  assert.equal(second.stderr, "");

  const other = await runHook(interactive("sess-b"), fetchJson(401, DELETED), home);
  assert.match(other.stderr, /has been deleted/);

  const lapses = readFileSync(join(home, ".acp", "lapse.log"), "utf8").trim().split("\n");
  assert.equal(lapses.length, 3);
});

test("interactive workspace_deleted with no session id: at most once per 24h", async () => {
  const home = tmpHome();
  const first = await runHook(interactive(undefined), fetchJson(401, DELETED), home);
  assert.match(first.stderr, /has been deleted/);
  assert.ok(existsSync(join(home, ".acp", "notices", "workspace-deleted.no-session")));
  const second = await runHook(interactive(undefined), fetchJson(401, DELETED), home);
  assert.equal(second.result.block, undefined);
  assert.equal(second.stderr, "");
});

test("unattended workspace_deleted blocks every call with the deleted message", async () => {
  const home = tmpHome();
  for (let i = 0; i < 2; i++) {
    const { result } = await runHook(background("sess-u"), fetchJson(401, DELETED), home);
    assert.equal(result.block, true);
    assert.match(result.blockReason, /has been deleted/);
    assert.match(result.blockReason, /acp-uninstall/);
  }
});
