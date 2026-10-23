// Identity comes from Codex transport metadata, never the model request body.
// These headers are internal only; api-forwarder's x-codex denylist removes them.
export const BUDGET_IDENTITY_HEADER = "x-codex-router-budget-identity";
export const BUDGET_REQUEST_HEADER = "x-codex-router-budget-request";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cumulativeBudgetEnabled(route) {
  return route?.workingInputLimits?.cumulative !== undefined;
}

export function budgetError(message) {
  const error = new Error(message);
  error.status = 400;
  error.providerStatus = 400;
  error.code = "router_resource_budget_exceeded";
  return error;
}

export function nativeBudgetIdentity(headers) {
  const raw = headers?.["x-codex-turn-metadata"];
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16_384) {
    throw budgetError("The guarded route requires unambiguous native turn metadata.");
  }
  let metadata;
  try { metadata = JSON.parse(raw); } catch { throw budgetError("The guarded route requires valid native turn metadata."); }
  // Bundled Desktop 0.159.0-alpha.12.1 app-server roots omit the analytics
  // source or use agent_created_thread. Neither denotes a spawned worker.
  // Those shapes require the observed session/thread transport agreement;
  // root_turn_id and the absence of all worker lineage are still checked.
  const desktopRoot = (metadata?.thread_source === undefined || metadata.thread_source === "agent_created_thread") &&
    UUID.test(metadata?.session_id) && metadata.session_id === metadata.thread_id &&
    headers["thread-id"] === metadata.thread_id && headers["session-id"] === metadata.session_id;
  const root = (metadata?.thread_source === "user" || desktopRoot) &&
    !metadata.parent_thread_id && !metadata.parent_turn_id && !metadata.subagent_kind;
  const worker = metadata?.thread_source === "subagent" && metadata.subagent_kind === "thread_spawn" &&
    UUID.test(metadata.parent_thread_id) && UUID.test(metadata.parent_turn_id);
  if (!UUID.test(metadata?.thread_id) || !UUID.test(metadata?.turn_id) ||
      !UUID.test(metadata?.root_turn_id) || !["turn", "compaction"].includes(metadata.request_kind) || (!root && !worker) ||
      (headers["thread-id"] && headers["thread-id"] !== metadata.thread_id) ||
      (headers["session-id"] && headers["session-id"] !== metadata.session_id) ||
      (root && (headers["x-openai-subagent"] || headers["x-codex-parent-thread-id"] || metadata.root_turn_id !== metadata.turn_id)) ||
      (worker && headers["x-codex-parent-thread-id"] !== metadata.parent_thread_id)) {
    throw budgetError("The guarded route cannot establish this native execution scope.");
  }
  return { version: 1, kind: root ? "root" : "worker", threadId: metadata.thread_id, turnId: metadata.turn_id };

}

export function bridgeBudgetIdentity(route, request, payload) {
  if (!cumulativeBudgetEnabled(route)) return payload;
  const identity = nativeBudgetIdentity(request.headers);
  const requestId = request.codexRouterRequestId;
  if (typeof requestId !== "string" || requestId.length > 160 || !requestId) {
    throw budgetError("The guarded route requires a router request identity.");
  }
  // Replace rather than merge: caller/model-supplied extra_headers may neither
  // override identity nor smuggle unrelated control headers into this hop.
  return { ...payload, extra_headers: {
    [BUDGET_IDENTITY_HEADER]: JSON.stringify(identity),
    [BUDGET_REQUEST_HEADER]: requestId,
  } };
}

export function internalBudgetIdentity(headers) {
  let identity;
  try { identity = JSON.parse(headers?.[BUDGET_IDENTITY_HEADER]); } catch { /* Refuse below. */ }
  const requestId = headers?.[BUDGET_REQUEST_HEADER];
  if (identity?.version !== 1 || !["root", "worker"].includes(identity.kind) ||
      !UUID.test(identity.threadId) || !UUID.test(identity.turnId) ||
      typeof requestId !== "string" || !/^[a-zA-Z0-9:._-]{1,160}$/.test(requestId)) {
    throw budgetError("The guarded route requires the router's internal execution identity.");
  }
  return { identity, requestId };
}
