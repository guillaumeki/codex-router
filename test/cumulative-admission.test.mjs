import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const state = mkdtempSync(path.join(os.tmpdir(), "cumulative-admission-"));
process.env.MODEL_ROUTER_STATE_DIR = state;
process.env.CODEX_ROUTER_STATE_DIR = state;
const { CumulativeUsageAdmission, USAGE_EVENTS_PATH, recordUsageEvent, recentUsageEvents, hourlyUsageRollup } = await import("../src/usage-events.mjs");
const { nativeBudgetIdentity, bridgeBudgetIdentity, internalBudgetIdentity, BUDGET_IDENTITY_HEADER, BUDGET_REQUEST_HEADER } = await import("../src/native-budget-identity.mjs");
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/native-budget-identity.json", import.meta.url))).requests;
const identity = nativeBudgetIdentity(fixtures[0]);
const limits = { maxAttempts: 60, maxInputTokens: 10_000_000 };
let sequence = 0;
const ledger = () => path.join(state, `ledger-${++sequence}.jsonl`);
const request = (extra = {}) => ({ identity, requestId: "test-request", estimatedInput: 100, limits, ...extra });
const refused = (fn) => assert.throws(fn, (error) => error.status === 400 && error.code === "router_resource_budget_exceeded");
test.after(() => rmSync(state, { recursive: true, force: true }));

test("actual native tool rounds, root new turn, child and completed-worker followup classify without agent names", () => {
  assert.deepEqual(nativeBudgetIdentity(fixtures[0]), nativeBudgetIdentity(fixtures[1]));
  assert.equal(nativeBudgetIdentity(fixtures[2]).threadId, identity.threadId);
  assert.notEqual(nativeBudgetIdentity(fixtures[2]).turnId, identity.turnId);
  assert.deepEqual(nativeBudgetIdentity(fixtures[9]), nativeBudgetIdentity(fixtures[10]), "native compaction shares its originating execution allowance");
  const child = nativeBudgetIdentity(fixtures[5]);
  const followup = nativeBudgetIdentity(fixtures[8]);
  assert.equal(child.kind, "worker");
  assert.equal(child.threadId, followup.threadId);
  assert.notEqual(child.turnId, followup.turnId);
  const admission = new CumulativeUsageAdmission(ledger());
  admission.reserve(request({ identity: child, limits: { ...limits, maxAttempts: 1 } }));
  refused(() => admission.reserve(request({ identity: followup, requestId: "follow-up", limits: { ...limits, maxAttempts: 1 } })));
  const rootAdmission = new CumulativeUsageAdmission(ledger());
  rootAdmission.reserve(request({ limits: { ...limits, maxAttempts: 1 } }));
  rootAdmission.reserve(request({ identity: nativeBudgetIdentity(fixtures[2]), requestId: "next-root-turn", limits: { ...limits, maxAttempts: 1 } }));
  for (const headers of [{}, { "x-codex-turn-metadata": "{}" },
    { ...fixtures[0], "thread-id": "ambiguous" },
    { ...fixtures[5], "x-codex-parent-thread-id": "wrong-parent" },
    { "x-codex-turn-metadata": "x".repeat(16_385) }]) refused(() => nativeBudgetIdentity(headers));
});

test("bundled Desktop app-server roots retain exact turn boundaries without inventing lineage", () => {
  const desktop = JSON.parse(readFileSync(new URL("./fixtures/native-budget-identity.json", import.meta.url))).desktop_requests;
  for (const offset of [0, 4]) {
    const first = nativeBudgetIdentity(desktop[offset]);
    assert.equal(first.kind, "root");
    assert.deepEqual(nativeBudgetIdentity(desktop[offset + 1]), first);
    for (const next of [desktop[offset + 2], desktop[offset + 3]]) {
      const identity = nativeBudgetIdentity(next);
      assert.equal(identity.threadId, first.threadId);
      assert.notEqual(identity.turnId, first.turnId);
    }
    const source = JSON.parse(desktop[offset]["x-codex-turn-metadata"]);
    for (const patch of [
      { thread_source: "unknown" }, { thread_source: null },
      { parent_thread_id: first.threadId }, { parent_turn_id: first.turnId },
      { subagent_kind: "thread_spawn" }, { root_turn_id: identity.turnId },
      { root_turn_id: undefined }, { request_kind: undefined },
      { session_id: identity.threadId },
    ]) {
      refused(() => nativeBudgetIdentity({ ...desktop[offset], "x-codex-turn-metadata": JSON.stringify({ ...source, ...patch }) }));
    }
    for (const key of ["thread-id", "session-id"]) {
      refused(() => nativeBudgetIdentity({ ...desktop[offset], [key]: undefined }));
      refused(() => nativeBudgetIdentity({ ...desktop[offset], [key]: identity.threadId }));
    }
    for (const key of ["x-openai-subagent", "x-codex-parent-thread-id"]) {
      refused(() => nativeBudgetIdentity({ ...desktop[offset], [key]: first.threadId }));
    }
    const admission = new CumulativeUsageAdmission(ledger());
    admission.reserve(request({ identity: first, limits: { ...limits, maxAttempts: 1 } }));
    refused(() => admission.reserve(request({ identity: nativeBudgetIdentity(desktop[offset + 1]), requestId: "tool-round", limits: { ...limits, maxAttempts: 1 } })));
    admission.reserve(request({ identity: nativeBudgetIdentity(desktop[offset + 2]), requestId: "new-turn", limits: { ...limits, maxAttempts: 1 } }));
  }
});

test("only opted-in routes replace caller extra_headers with router-owned identity", () => {
  const payload = { extra_headers: { [BUDGET_IDENTITY_HEADER]: "spoof", [BUDGET_REQUEST_HEADER]: "spoof", authorization: "spoof" } };
  const route = { workingInputLimits: { cumulative: limits } };
  const output = bridgeBudgetIdentity(route, { headers: fixtures[0], codexRouterRequestId: "router-owned:1" }, payload);
  assert.deepEqual(internalBudgetIdentity(output.extra_headers), { identity, requestId: "router-owned:1" });
  assert.equal(output.extra_headers.authorization, undefined);
  assert.equal(bridgeBudgetIdentity({}, {}, payload), payload);
  refused(() => internalBudgetIdentity({}));
  refused(() => bridgeBudgetIdentity(route, { headers: fixtures[0] }, payload));
});

test("concurrent near-cap admission includes outstanding reservations; siblings remain separate", async () => {
  const admission = new CumulativeUsageAdmission(ledger());
  let sends = 0;
  const send = async (i) => { admission.reserve(request({ requestId: `parallel-${i}`, estimatedInput: 2, limits: { maxAttempts: 60, maxInputTokens: 5 } })); sends++; };
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => send(i)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(sends, 2);
  const sibling = { ...identity, threadId: "00000000-0000-0000-0000-000000000001" };
  admission.reserve(request({ identity: sibling, requestId: "sibling" }));
});

test("actual attempts, including retry ordinals, reach 60; attempt 61 never reaches transport", () => {
  const file = ledger(); const admission = new CumulativeUsageAdmission(file);
  let sends = 0;
  for (let i = 0; i < 60; i++) { admission.reserve(request()); sends++; }
  refused(() => { admission.reserve(request()); sends++; });
  assert.equal(sends, 60);
  const rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).slice(1);
  assert.deepEqual(rows.map((row) => row.attemptOrdinal), Array.from({ length: 60 }, (_, i) => i + 1));
  const restarted = new CumulativeUsageAdmission(file);
  refused(() => restarted.reserve(request({ requestId: "outer-router-retry" })));
});

test("unmatched crash reservation survives restart and equality is admitted", () => {
  const file = ledger(); const one = new CumulativeUsageAdmission(file);
  one.reserve(request({ estimatedInput: 10, limits: { maxAttempts: 60, maxInputTokens: 10 } }));
  const two = new CumulativeUsageAdmission(file);
  refused(() => two.reserve(request({ requestId: "after-crash", estimatedInput: 1, limits: { maxAttempts: 60, maxInputTokens: 10 } })));
});

test("estimated and cached-inclusive observed input consume the larger value; missing usage never refunds", () => {
  for (const outcome of [{}, { observedInput: undefined, cachedInput: 999 }, { observedInput: -1 }, { observedInput: 1.5 }, { observedInput: 0 }]) {
    const admission = new CumulativeUsageAdmission(ledger());
    const ticket = admission.reserve(request({ estimatedInput: 10, limits: { maxAttempts: 60, maxInputTokens: 10 } }));
    assert.equal(admission.settle(ticket, outcome), true);
    assert.equal(admission.settle(ticket, { observedInput: 999 }), false);
    refused(() => admission.reserve(request({ estimatedInput: 1, limits: { maxAttempts: 60, maxInputTokens: 10 } })));
  }
  const file = ledger(); const admission = new CumulativeUsageAdmission(file);
  const ticket = admission.reserve(request({ estimatedInput: 10 }));
  admission.settle(ticket, { observedInput: 15, cachedInput: 20 });
  const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1));
  assert.equal(row.observedInclusiveInput, 20);
  refused(() => new CumulativeUsageAdmission(file).reserve(request({ estimatedInput: 1, limits: { maxAttempts: 60, maxInputTokens: 20 } })));
});

test("read, malformed/truncated recovery, duplicate and out-of-order outcomes fail closed boundedly", () => {
  const directory = path.join(state, "not-a-file"); mkdirSync(directory);
  refused(() => new CumulativeUsageAdmission(directory).reserve(request()));
  for (const body of ['{"unfinished":', '{}', '{bad}\n', '\n']) {
    const file = ledger(); writeFileSync(file, body);
    refused(() => new CumulativeUsageAdmission(file).reserve(request()));
  }
  const file = ledger(); const admission = new CumulativeUsageAdmission(file);
  const ticket = admission.reserve(request()); admission.settle(ticket, { observedInput: 5 });
  const rows = readFileSync(file, "utf8").trim().split("\n");
  for (const changed of [[...rows, rows[2]], [rows[0], rows[2], rows[1]], [rows[0], rows[1], rows[1]]]) {
    const bad = ledger(); writeFileSync(bad, changed.join("\n") + "\n");
    refused(() => new CumulativeUsageAdmission(bad).reserve(request()));
  }
  refused(() => admission.settle({ ...ticket, attemptOrdinal: 99 }));
});

test("concurrent outcomes may finish in reverse order without refunding outstanding work", () => {
  const file = ledger(); const admission = new CumulativeUsageAdmission(file);
  const first = admission.reserve(request({ estimatedInput: 10 }));
  const second = admission.reserve(request({ estimatedInput: 10 }));
  admission.settle(second, { observedInput: 15 });
  admission.settle(first, { observedInput: 5 });
  refused(() => new CumulativeUsageAdmission(file).reserve(request({ estimatedInput: 1, limits: { maxAttempts: 60, maxInputTokens: 25 } })));
});

test("checked append failure denies send and poisons future admission", () => {
  const file = ledger(); const admission = new CumulativeUsageAdmission(file);
  admission.reserve(request()); renameSync(file, file + ".retained"); mkdirSync(file);
  let sends = 0;
  refused(() => { admission.reserve(request()); sends++; });
  rmSync(file, { recursive: true }); renameSync(file + ".retained", file);
  refused(() => { admission.reserve(request()); sends++; });
  assert.equal(sends, 0);
});

test("legacy completed/billed aggregates ignore reservation and outcome rows; boundary is explicit", () => {
  recordUsageEvent({ model: "legacy", provider: "opencode-go", status: 200, inputTokens: 7, billedInputTokens: 9, outputTokens: 2 });
  const before = recentUsageEvents();
  const admission = new CumulativeUsageAdmission(USAGE_EVENTS_PATH);
  const ticket = admission.reserve(request()); admission.settle(ticket, { observedInput: 500 });
  assert.deepEqual(recentUsageEvents(), before);
  const rows = readFileSync(USAGE_EVENTS_PATH, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[1].cumulativeAdmission, "boundary");
  const rollup = hourlyUsageRollup();
  assert.equal(rollup.reduce((sum, bucket) => sum + bucket.requests, 0), 1);
  assert.equal(rollup.reduce((sum, bucket) => sum + bucket.tokens, 0), 11);
});
