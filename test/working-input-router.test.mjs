import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { nativeCompactionIntent } from "../src/native-budget-identity.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";
import { requestInputSize } from "../src/response-usage.mjs";
import { maxImageTokensForRoute } from "../src/prompt-image-usage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-working-input-router-caller-key-with-sufficient-length";
const INTERNAL_KEY = "test-working-input-router-internal-key-with-sufficient-length";

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function waitForReady(base, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(child.testErrors());
    try { if ((await fetch(`${base}/models`)).ok) return; } catch { /* Not yet bound. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Router did not become ready: ${child.testErrors()}`);
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function waitForUsageEvents(stateDir, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = usageEvents(stateDir);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Usage ledger did not record ${count} requests.`);
}

test("native compaction intent validates observed root, Desktop and worker scope", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/native-budget-identity.json", import.meta.url)));
  assert.equal(nativeCompactionIntent({}), false);
  for (const headers of [...fixtures.requests, ...fixtures.desktop_requests]) {
    const metadata = JSON.parse(headers["x-codex-turn-metadata"]);
    assert.equal(nativeCompactionIntent(headers), metadata.request_kind === "compaction");
    const compact = { ...headers, "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "compaction" }) };
    assert.equal(nativeCompactionIntent(compact), true);
    assert.throws(() => nativeCompactionIntent({ ...compact, "thread-id": "invalid" }),
      (error) => error.code === "router_resource_budget_exceeded");
  }
  for (const raw of ["{", "null", "x".repeat(16_385)]) {
    assert.throws(() => nativeCompactionIntent({ "x-codex-turn-metadata": raw }),
      (error) => error.code === "router_resource_budget_exceeded");
  }
});

test("route working input limits reject before transport and preserve admitted turns and bounded compaction", { timeout: 60_000 }, async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "working-input-router-"));
  const upstreamRequests = [];
  let emptyOnce = false;
  let quotaOnce = false;
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET") { json(response, 200, { ok: true, credential_present: true }); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const payload = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"));
    upstreamRequests.push(payload);
    if (quotaOnce) {
      quotaOnce = false;
      json(response, 402, { error: { type: "insufficient_quota", message: "Usage exhausted" } });
      return;
    }
    if (emptyOnce) {
      emptyOnce = false;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"id":"resp_empty","status":"completed","output":[]}}\n\ndata: [DONE]\n\n');
      return;
    }
    if (payload.stream === true) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"type":"response.output_text.delta","delta":"verified"}\n\ndata: {"type":"response.completed","response":{"id":"resp_replay","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"verified"}]}]}}\n\ndata: [DONE]\n\n');
      return;
    }
    json(response, 200, {
      id: `resp_working_input_${upstreamRequests.length}`, object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "verified" }] }],
      usage: { input_tokens: 100, output_tokens: 1 },
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const limits = {
    generation: { maxEstimatedTokens: 10_000, maxTextBytes: 20_000 },
    compaction: { maxEstimatedTokens: 100_000, maxTextBytes: 400_000 },
  };
  const entries = [limits,
    { ...limits, generation: { maxEstimatedTokens: 2_000, maxTextBytes: 1_000_000 } },
    { ...limits, generation: { maxEstimatedTokens: 1_000_000, maxTextBytes: 5_000 } },
    undefined,
    { generation: { maxEstimatedTokens: 200_000, maxTextBytes: 1_048_576 },
      compaction: { maxEstimatedTokens: 1_000_000, maxTextBytes: 4_194_304 } },
  ].map((workingInputLimits, index) => ({
    ...userModelEntry({ providerId: index === 4 ? "local" : "custom", upstreamId: `working-input-${index}`, priority: 900 + index,
      metadata: { autoCompact: index === 4 ? 1_000_000 : 1_000, ...(index >= 3 ? { contextWindow: 4_000_000 } : {}), ...(workingInputLimits ? { workingInputLimits } : {}) } }),
    ...(index === 4 ? {} : { endpoint: { baseUrl: `${upstreamBase}/v1`, protocol: "openai-responses", keyless: true } }),
  }));
  const modelsFile = path.join(stateDir, "user-models.json");
  writeFileSync(modelsFile, JSON.stringify({ version: 1, models: entries }));
  writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["local", "custom", "opencode-go"] }));
  writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "test-working-input-provider-key");
  writeFileSync(path.join(stateDir, "failover.json"), JSON.stringify({ version: 1, enabled: true,
    chain: ["opencode-go/deepseek-v4.1-flash"] }));
  const port = await openPort();
  const base = callerBaseUrl(port, CALLER_KEY);
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root,
    env: {
      ...process.env, CODEX_HOME: path.join(stateDir, "codex-home"),
      MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: modelsFile,
      CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_GATEWAY_BASE_URL: `${upstreamBase}/v1`, CODEX_NATIVE_BASE_URL: upstreamBase,
      CODEX_ROUTER_API_BASE_URL: `${upstreamBase}/v1`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_API_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      MODEL_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_NO_DISCOVERY: "0",
    }, stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16_384); });
  child.testErrors = () => errors;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForReady(base, child);
  const options = {
    stream: false, instructions: "Preserve developer instructions.",
    tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { file: { type: "string" } } } }],
  };
  const send = async (index, extra = {}, headers = {}, endpoint = "/responses") => {
    const result = await fetch(`${base}${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: entries[index].slug, ...options, input: "hello", ...extra }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: result.status, body: await result.json() };
  };
  const reject = async (index, extra, headers = {}, endpoint) => {
    const before = upstreamRequests.length;
    const result = await send(index, extra, headers, endpoint);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, "router_resource_budget_exceeded");
    assert.equal(result.body.error.type, "resource_budget_error");
    assert.equal(upstreamRequests.length, before, "local denial must send zero upstream requests");
  };
  const text = (content) => ({ type: "message", role: "user", content });
  const history = [text("old context ".repeat(3_000)), text("continue")];
  for (const headers of [{}, { "x-openai-subagent": "child-1" }]) {
    await reject(0, { input: history }, headers);
    await reject(0, { instructions: "界".repeat(10_000) }, headers);
    await reject(0, { tools: [{ type: "function", name: "read", description: "界".repeat(10_000), parameters: { type: "object" } }] }, headers);
    await reject(0, { input: [
      { type: "function_call", name: "read", call_id: "call-pending", arguments: "{}" },
      { type: "function_call_output", call_id: "call-pending", output: "界".repeat(10_000) },
    ] }, headers);
    // Independent token and UTF-8 byte ceilings, including on small requests.
    await reject(1, { instructions: "x".repeat(8_000) }, headers);
    await reject(2, { instructions: "界".repeat(2_000) }, headers);
  }
  const deniedRows = await waitForUsageEvents(stateDir, 12);
  assert.equal(deniedRows.length, 12);
  assert.ok(deniedRows.every((row) => row.status === 400 && row.inputTokens === undefined && row.responseStartMs === undefined),
    "local refusal never invents billed tokens or upstream latency");
  const allowed = { input: [text("small inherited history"), text("continue")], ...options };
  const result = await send(0, allowed);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const forwarded = upstreamRequests.at(-1);
  for (const field of ["input", "instructions", "tools", "stream"]) {
    assert.deepEqual(forwarded[field], allowed[field], `allowed ${field} is unchanged`);
  }
  // Exact equality admits; reducing either ceiling by one refuses the same bytes.
  const measured = requestInputSize(JSON.stringify(forwarded), { maxTokensPerImage: maxImageTokensForRoute(entries[0]) });
  const exactBytes = { ...allowed, instructions: options.instructions + "x".repeat(20_000 - measured.textBytes) };
  assert.equal((await send(0, exactBytes)).status, 200);
  await reject(0, { ...exactBytes, instructions: exactBytes.instructions + "x" });
  assert.equal((await send(1, allowed)).status, 200);
  const tokenMeasured = requestInputSize(JSON.stringify(upstreamRequests.at(-1)), { maxTokensPerImage: maxImageTokensForRoute(entries[1]) });
  const exactTokens = { ...allowed, instructions: options.instructions + "x".repeat(6_600 - tokenMeasured.textBytes) };
  assert.equal((await send(1, exactTokens)).status, 200);
  await reject(1, { ...exactTokens, instructions: exactTokens.instructions + "x" });
  // No configured policy means no new ceiling, including the native path.
  assert.equal((await send(3, { input: history })).status, 200);
  const native = await fetch(`${base}/responses`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-working-native-fixture", stream: false, input: history }), signal: AbortSignal.timeout(10_000) });
  assert.equal(native.status, 200, await native.text());

  emptyOnce = true;
  const beforeRetry = upstreamRequests.length;
  const replay = await fetch(`${base}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: entries[0].slug, input: "hello", stream: true }), signal: AbortSignal.timeout(10_000),
  });
  const replayBody = await replay.text();
  assert.equal(replay.status, 200, replayBody);
  assert.match(replayBody, /verified/);
  assert.equal(upstreamRequests.length, beforeRetry + 2, "empty completion retries once");
  assert.deepEqual(upstreamRequests.at(-1), upstreamRequests.at(-2), "replay preserves admitted bytes");

  // Native automatic compaction uses ordinary /responses, with no body trigger.
  // Its validated transport intent must survive replay and failover as well.
  const nativeFixtures = JSON.parse(readFileSync(new URL("./fixtures/native-budget-identity.json", import.meta.url))).requests;
  const compactHeaders = nativeFixtures[10];
  assert.equal(JSON.parse(compactHeaders["x-codex-turn-metadata"]).request_kind, "compaction");
  const nativeHistory = [text("x".repeat(800_000))];
  const beforeNativeCompact = upstreamRequests.length;
  const admittedCompact = await send(4, { input: nativeHistory }, compactHeaders);
  assert.equal(admittedCompact.status, 200, JSON.stringify(admittedCompact.body));
  assert.equal(upstreamRequests.length, beforeNativeCompact + 1);
  await reject(4, { input: nativeHistory }, nativeFixtures[9]);
  await reject(4, { input: nativeHistory, request_kind: "compaction" });
  await reject(4, { input: nativeHistory }, { ...compactHeaders, "thread-id": "invalid" });
  await reject(4, { input: [text("x".repeat(4_300_000))] }, compactHeaders);
  emptyOnce = true;
  const beforeCompactRetry = upstreamRequests.length;
  const compactReplay = await fetch(`${base}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json", ...compactHeaders },
    body: JSON.stringify({ model: entries[4].slug, input: nativeHistory, stream: true }), signal: AbortSignal.timeout(10_000),
  });
  const compactReplayBody = await compactReplay.text();
  assert.equal(compactReplay.status, 200, compactReplayBody);
  assert.match(compactReplayBody, /verified/);
  assert.equal(upstreamRequests.length, beforeCompactRetry + 2);
  writeFileSync(path.join(stateDir, "failover.json"), JSON.stringify({ version: 1, enabled: true, chain: [entries[4].slug] }));
  quotaOnce = true;
  const beforeCompactFailover = upstreamRequests.length;
  const compactFailover = await send(3, { input: nativeHistory }, compactHeaders);
  assert.equal(compactFailover.status, 200, JSON.stringify(compactFailover.body));
  assert.equal(upstreamRequests.length, beforeCompactFailover + 2);
  writeFileSync(path.join(stateDir, "provider-cooldowns.json"), "{}");

  // V1 and native V2 use the larger, finite compaction allowance.
  for (const endpoint of ["/responses/compact", "/responses"]) {
    const compact = (input) => ({ input: endpoint === "/responses" ? [...input, { type: "compaction_trigger" }] : input });
    const before = upstreamRequests.length;
    const compacted = await send(0, compact(history), {}, endpoint);
    assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
    assert.equal(upstreamRequests.length, before + 1, "old context reaches bounded summarizer");
    await reject(0, compact([text("界".repeat(150_000))]), {}, endpoint);
  }
  // A requested guarded Go route owns its allowance even when a different,
  // larger configured summarizer is selected because Go is cooling down.
  writeFileSync(path.join(stateDir, "failover.json"), JSON.stringify({ version: 1, enabled: true, chain: [entries[3].slug] }));
  writeFileSync(path.join(stateDir, "provider-cooldowns.json"), JSON.stringify({
    "opencode-go": { until: new Date(Date.now() + 60_000).toISOString(), reason: "out_of_usage" },
  }));
  const largeInput = [text("x".repeat(4_300_000))];
  for (const endpoint of ["/responses/compact", "/responses"]) {
    const before = upstreamRequests.length;
    const result = await fetch(`${base}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode-go/deepseek-v4.1-flash", stream: false,
        input: endpoint === "/responses" ? [...largeInput, { type: "compaction_trigger" }] : largeInput }),
      signal: AbortSignal.timeout(10_000) });
    const body = await result.json();
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(body.error.code, "router_resource_budget_exceeded");
    assert.equal(upstreamRequests.length, before, "requested compaction budget must deny before another summarizer sends");
  }
  const nativeCompact = await fetch(`${base}/responses/compact`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-working-native-fixture", stream: false, input: largeInput }), signal: AbortSignal.timeout(10_000) });
  assert.equal(nativeCompact.status, 200, await nativeCompact.text());
  writeFileSync(path.join(stateDir, "provider-cooldowns.json"), "{}");
  writeFileSync(path.join(stateDir, "failover.json"), JSON.stringify({ version: 1, enabled: true, chain: ["opencode-go/deepseek-v4.1-flash"] }));
  // A quota response can select a limited destination. Its rebuilt request is
  // denied locally before that destination's transport, with no further hop.
  quotaOnce = true;
  const beforeFailover = upstreamRequests.length;
  const failedOver = await send(3, { instructions: "x".repeat(700_000) });
  assert.equal(failedOver.status, 400, JSON.stringify(failedOver.body));
  assert.equal(failedOver.body.error.code, "router_resource_budget_exceeded");
  assert.equal(upstreamRequests.length, beforeFailover + 1, "only the original quota request is sent");
});
