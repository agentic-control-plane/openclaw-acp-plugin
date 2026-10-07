// ACP plugin conformance adapter for openclaw-acp-plugin.
// Corpus: davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json
// Tracking: davidcrowe/gatewaystack-connect#1344
//
// Both corpus capabilities ("notice" and "post-tool") are declared
// "not-possible" for this plugin: OpenClaw's plugin API exposes only
// before_tool_call — there is no after-tool/post-tool hook for a plugin to
// register, so the plugin never calls POST /govern/tool-output on the way
// out and has no native post-tool payload to build or reply to surface.
// Because nothing is "supported" here, there is nothing to drive against a
// fake gateway (no notice-shown / notice-shadow-off / post-tool-fields
// cases apply) and no EXPECTED_DIVERGENCES list — a divergence can only
// exist for a supported capability, and none exists here.
//
// What this file actually checks is the STATED FACT behind both
// not-possible rows: that the plugin's register() call, exercised against
// a fake OpenClaw host, registers before_tool_call and nothing that looks
// like an after-tool/post-tool hook. If OpenClaw ever ships an after-tool
// hook and this plugin starts registering it, this test fails loudly and
// both corpus rows above have gone stale.
//
// Run with: npm test (builds src/ first, then node --test test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "fixtures", "plugin-corpus.json");
const PINNED_FINGERPRINT = "aa186d3fb3e7d18c";
const PLUGIN_ID = "openclaw-acp-plugin";

// A hook name that behaves like an after-tool/post-tool hook, even one
// OpenClaw might name differently than we expect today.
const AFTER_TOOL_HOOK_PATTERN = /after.?tool|post.?tool|tool.?(result|output|complete|end)/i;

function loadCorpus() {
  const raw = readFileSync(CORPUS_PATH);
  const fingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  assert.equal(
    fingerprint,
    PINNED_FINGERPRINT,
    `vendored plugin-corpus.json at ${CORPUS_PATH} does not match the pinned fingerprint ` +
      `(${PINNED_FINGERPRINT}) — got ${fingerprint}. Re-vendor a byte-identical copy from ` +
      `davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json and update the pin ` +
      `together if the corpus changed intentionally.`
  );
  return JSON.parse(raw.toString("utf8"));
}

function corpusRow(corpus, capability) {
  const row = corpus.harnesses.find(
    (h) => h.plugin === PLUGIN_ID && h.capability === capability
  );
  assert.ok(row, `corpus has no ${PLUGIN_ID}/${capability} row`);
  return row;
}

// dist/plugin.js is CommonJS (`exports.default = ...`); Node's ESM interop
// surfaces that as `module.default.default` rather than `module.default`
// (see test/fail-posture.test.mjs for the same pattern).
const pluginModule = await import("../dist/plugin.js");
const plugin = pluginModule.default.default ?? pluginModule.default;

// Registers the plugin against a fake OpenClaw host that records every
// hook name it's asked to register, then hands back what was recorded.
function registerAgainstFakeHost() {
  const registeredHooks = [];
  const fakeApi = {
    on(hook, _handler, _opts) {
      registeredHooks.push(hook);
    },
  };
  plugin.register(fakeApi);
  return registeredHooks;
}

test("vendored corpus fingerprint matches the pinned value", () => {
  loadCorpus();
});

test("openclaw-acp-plugin/notice is declared not-possible with a non-empty reason", () => {
  const corpus = loadCorpus();
  const row = corpusRow(corpus, "notice");
  assert.equal(row.status, "not-possible");
  assert.equal(typeof row.reason, "string");
  assert.ok(row.reason.trim().length > 0, "reason must be non-empty");
});

test("openclaw-acp-plugin/post-tool is declared not-possible with a non-empty reason", () => {
  const corpus = loadCorpus();
  const row = corpusRow(corpus, "post-tool");
  assert.equal(row.status, "not-possible");
  assert.equal(typeof row.reason, "string");
  assert.ok(row.reason.trim().length > 0, "reason must be non-empty");
});

// The concrete "stated fact" check backing BOTH not-possible rows above:
// both reasons rest on the same underlying fact (OpenClaw exposes no
// after-tool hook to plugins), so one shared registration check is enough
// to back both assertions rather than duplicating it per capability.
test("register() only registers before_tool_call — no after-tool/post-tool hook exists to go stale", () => {
  const registeredHooks = registerAgainstFakeHost();

  // Proves the fake harness actually exercised the real registration path
  // (not a no-op registration whose absence of post-tool hooks would be
  // vacuously true).
  assert.ok(
    registeredHooks.includes("before_tool_call"),
    `expected the plugin to register "before_tool_call"; got [${registeredHooks.join(", ")}]`
  );

  // The concrete claim behind both not-possible rows: nothing registered
  // looks like an after-tool/post-tool hook. Checked both against the
  // literal hook name this plugin's src/plugin.ts knows about today, and
  // defensively via a naming-convention regex so a differently-spelled new
  // hook still trips this.
  for (const hook of registeredHooks) {
    assert.notEqual(hook, "after_tool_call", `plugin registered "${hook}" — the notice/post-tool corpus rows are now stale`);
    assert.doesNotMatch(
      hook,
      AFTER_TOOL_HOOK_PATTERN,
      `registered hook "${hook}" looks like an after-tool/post-tool hook — the notice/post-tool corpus rows are now stale`
    );
  }
});
