import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LIMITS = {
  generation: { maxEstimatedTokens: 200_000, maxTextBytes: 1_048_576 },
  compaction: { maxEstimatedTokens: 1_000_000, maxTextBytes: 4_194_304 },
};

test("curation preserves opt-in limits and leaves absent limits absent", () => {
  const base = { providerId: "custom", upstreamId: "working-input", priority: 1 };
  assert.equal(userModelEntry(base).workingInputLimits, undefined);
  assert.deepEqual(userModelEntry({ ...base, metadata: { workingInputLimits: LIMITS } }).workingInputLimits, LIMITS);
});

test("registry validates both finite positive working input limit pairs", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "working-input-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "registry.json");
  const entry = { ...userModelEntry({ providerId: "custom", upstreamId: "working-input", priority: 1 }),
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true } };
  const load = (limits) => {
    const model = limits === undefined ? entry : { ...entry, workingInputLimits: limits };
    writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Custom",
      kind: "openai-compatible", ownedBy: "custom", authMode: "per-model", perModelEndpoint: true }], models: [model] }));
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      "const { MODEL_BY_SLUG } = await import('./src/model-registry.mjs'); console.log(JSON.stringify(MODEL_BY_SLUG.get('custom/working-input')));"], {
      cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath,
        MODEL_ROUTER_STATE_DIR: dir, CODEX_HOME: path.join(dir, "codex"),
        MODEL_ROUTER_USER_MODELS: path.join(dir, "absent.json") },
    });
  };
  for (const limits of [undefined, LIMITS]) {
    const result = load(limits);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).workingInputLimits, limits);
  }
  for (const limits of [null, false, {}, [],
    { ...LIMITS, cumulative: { maxAttempts: 60, maxInputTokens: 10_000_000 } }, { generation: LIMITS.generation },
    { ...LIMITS, generation: { ...LIMITS.generation, maxTextBytes: "1048576" } },
    { ...LIMITS, compaction: { ...LIMITS.compaction, maxEstimatedTokens: 0 } },
    { ...LIMITS, compaction: { ...LIMITS.compaction, maxTextBytes: -1 } },
    { ...LIMITS, generation: { ...LIMITS.generation, maxEstimatedTokens: 1.5 } },
    { ...LIMITS, generation: { ...LIMITS.generation, maxEstimatedTokens: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    const result = load(limits);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid workingInputLimits/);
  }
});

test("DeepSeek trial lowers compaction without inflating provider capacity", async () => {
  const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
  const route = MODEL_BY_SLUG.get("opencode-go/deepseek-v4.1-flash");
  assert.equal(route.contextWindow, 1_000_000);
  assert.equal(route.autoCompact, 150_000);
  assert.deepEqual(route.workingInputLimits, { ...LIMITS, cumulative: { maxAttempts: 60, maxInputTokens: 10_000_000 } });
  assert.equal(MODEL_BY_SLUG.get("deepseek/deepseek-v4.1-flash").workingInputLimits, undefined);
});

test("admission counts UTF-8 instructions and tools below the usage estimator floor", async () => {
  const { requestInputSize, estimateInputTokens } = await import("../src/response-usage.mjs");
  const body = JSON.stringify({ instructions: "界", tools: [{ description: "é" }], input: "hello" });
  const size = requestInputSize(body);
  assert.equal(size.textBytes, Buffer.byteLength(body, "utf8"));
  assert.equal(size.estimatedTokens, Math.ceil(Buffer.byteLength(body, "utf8") / 3.3));
  assert.equal(estimateInputTokens(body), undefined, "usage substitution keeps its existing small-turn floor");
  const large = JSON.stringify({ instructions: "界".repeat(2_000) });
  assert.equal(requestInputSize(large).estimatedTokens, estimateInputTokens(large));
});

test("admission reuses image token bounds while counting textual JSON and ignoring ciphertext", async () => {
  const { requestInputSize } = await import("../src/response-usage.mjs");
  const { promptImageUsage } = await import("../src/prompt-image-usage.mjs");
  const body = Buffer.from(JSON.stringify({ instructions: "describe", encrypted_content: "opaque",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + "a".repeat(10_000) }] }] }));
  const images = promptImageUsage(body, 4096);
  const size = requestInputSize(body, { maxTokensPerImage: 4096 });
  assert.ok(images.bytes > 10_000);
  assert.equal(size.textBytes, body.byteLength - images.bytes - Buffer.byteLength('"opaque"'));
  assert.equal(size.estimatedTokens, Math.ceil(size.textBytes / 3.3) + 4096);
});
