import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";
import { bridgeBudgetIdentity, nativeBudgetIdentity } from "../src/native-budget-identity.mjs";
import { CumulativeUsageAdmission } from "../src/usage-events.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-cumulative-forwarder-internal-key-with-length";
const nativeHeaders = JSON.parse(readFileSync(new URL("./fixtures/native-budget-identity.json", import.meta.url))).requests[0];
const identity = nativeBudgetIdentity(nativeHeaders);
const limits = { maxAttempts: 60, maxInputTokens: 10_000_000 };
const budgetHeaders = (requestId = "actual-forwarder:1") => bridgeBudgetIdentity(
  { workingInputLimits: { cumulative: limits } }, { headers: nativeHeaders, codexRouterRequestId: requestId }, {},
).extra_headers;
const rows = (state) => {
  const file = path.join(state, "usage-events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
};

async function fixture(t, { seed = 0, pooled = false, reply, corrupt = false } = {}) {
  const state = mkdtempSync(path.join(os.tmpdir(), "cumulative-forwarder-"));
  const file = path.join(state, "usage-events.jsonl");
  if (corrupt) mkdirSync(file);
  if (seed) {
    const ledger = new CumulativeUsageAdmission(file);
    for (let i = 0; i < seed; i++) ledger.reserve({ identity, requestId: "pre-crash", estimatedInput: 1, limits });
  }
  const credentialStorePath = path.join(state, "provider-credentials.json");
  const poolStatePath = path.join(state, "provider-api-key-pools.json");
  if (pooled) execFileSync(process.execPath, ["--input-type=module", "-e",
    'const { addEnvironmentCredentialToPool } = await import("./src/provider-api-key-control.mjs"); for (const name of ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"]) await addEnvironmentCredentialToPool("opencode-go", name);'], {
    cwd: root, timeout: 5_000, env: { ...process.env, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath, MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      CODEX_HOME: path.join(state, "codex") },
  });
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push({ headers: request.headers, body });
    if (reply) { reply(response, received.length); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "chatcmpl_budget", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "admitted" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 25, prompt_cache_hit_tokens: 20, completion_tokens: 1, total_tokens: 26 } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = await openPort();
  const env = { ...process.env, CODEX_HOME: path.join(state, "codex"), MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_API_PORT: String(port), MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_QUIET: "1", MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
    MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath, OPENCODE_API_KEY: "LOCAL_POOL_ONE", OPENCODE_GO_API_KEY: "LOCAL_POOL_TWO",
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` };
  let child; let errors = "";
  const start = async () => {
    child = spawn(process.execPath, [path.join(root, "src/api-forwarder.mjs")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16_384); });
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (child.exitCode !== null) throw Error(errors);
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${internalKey}` }, signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      if (Date.now() > deadline) throw Error(errors);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const stop = async () => { if (child.exitCode === null) { const done = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await done; } };
  t.after(async () => { await stop(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); rmSync(state, { recursive: true, force: true }); });
  await start();
  const send = async ({ headers = budgetHeaders(), model = "opencode-go-deepseek-v4-1-flash", stream = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "admit this small request" }], stream,
        extra_headers: { "x-codex-router-budget-identity": "spoof" } }), signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.text() };
  };
  return { state, received, send, restart: async () => { await stop(); await start(); } };
}

test("actual nonpooled send/replay reserves once per send, restart retains crash attempts, denial sends zero", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { seed: 59 });
  assert.equal((await f.send()).status, 200);
  assert.equal(f.received.length, 1);
  const attempts = rows(f.state).filter((row) => row.cumulativeAdmission === "reservation");
  assert.equal(attempts.length, 60);
  assert.equal(rows(f.state).filter((row) => row.cumulativeAdmission === "outcome").length, 1);
  const denial = await f.send(); assert.equal(denial.status, 400, denial.body);
  assert.match(denial.body, /router_resource_budget_exceeded/);
  assert.equal(f.received.length, 1);
  await f.restart();
  assert.equal((await f.send({ headers: budgetHeaders("outer-retry:2") })).status, 400);
  assert.equal(f.received.length, 1);
  assert.equal((await f.send({ headers: {}, model: "opencode-go-glm-5-3" })).status, 200);
  assert.equal(f.received.length, 2, "unguarded sibling retains existing behavior");
  assert.equal(rows(f.state).filter((row) => row.cumulativeAdmission === "reservation").length, 60);
  for (const { headers, body } of f.received.slice(0, 1)) {
    assert.equal(Object.keys(headers).some((key) => key.startsWith("x-codex-")), false);
    assert.equal(body.extra_headers, undefined);
  }
});

test("actual pooled retry is denied after final reservation without sending another credential", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { seed: 59, pooled: true, reply: (response) => {
    response.writeHead(429, { "Content-Type": "application/json" }); response.end('{"error":{"message":"rate limited"}}');
  } });
  const result = await f.send();
  assert.equal(result.status, 400, result.body);
  assert.match(result.body, /router_resource_budget_exceeded/);
  assert.equal(f.received.length, 1, "denied inner pool retry must send zero bytes");
  assert.equal(rows(f.state).filter((row) => row.cumulativeAdmission === "reservation").length, 60);
  assert.equal(rows(f.state).filter((row) => row.cumulativeAdmission === "outcome").length, 1);
});

test("missing identity and unreadable accounting fail before real provider transport", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const denied = await f.send({ headers: {} });
  assert.equal(denied.status, 400, denied.body);
  assert.equal(f.received.length, 0);
  const broken = await fixture(t, { corrupt: true });
  const result = await broken.send();
  assert.equal(result.status, 400, result.body);
  assert.match(result.body, /router_resource_budget_exceeded/);
  assert.equal(broken.received.length, 0);
});

test("streamed provider usage is observed cached-inclusive and larger observed spend blocks the next send", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { reply: (response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10000001,"prompt_cache_hit_tokens":10000000,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
  } });
  assert.equal((await f.send({ stream: true })).status, 200);
  assert.equal(rows(f.state).find((row) => row.cumulativeAdmission === "outcome").observedInclusiveInput, 10_000_001);
  assert.equal((await f.send()).status, 400);
  assert.equal(f.received.length, 1);
});
