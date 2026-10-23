# DeepSeek V4.1 Flash across providers — 2026-09-11

DeepSeek released V4.1 Flash on 2026-09-10. There is no V4.1 Pro yet. This
note records what each provider serves, the evidence, and why the checked-in
routes look the way they do. Every existing V4 route stays listed.

## DeepSeek API (`deepseek`)

Sources: https://api-docs.deepseek.com/news/news260910,
https://api-docs.deepseek.com/quick_start/pricing/,
https://api-docs.deepseek.com/guides/thinking_mode,
https://api-docs.deepseek.com/guides/vision/,
https://api-docs.deepseek.com/quick_start/agent_integrations/codex/.

- Current ids are `deepseek-flash` and `deepseek-v4-pro`. The live `/models`
  response on 2026-09-10 listed exactly those two.
- `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired but still
  accepted, served by V4.1 Flash at Flash price, with no end date. The V4 Flash
  routes therefore keep working, now on V4.1 Flash.
- From 2026-09-14 04:00 UTC, `deepseek-v4-pro` requests are served by V4.1
  Flash at Flash rates until V4.1 Pro launches.
- `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24.
- V4.1 Flash: 1M context (Codex guide: `context_window` 1048576), 384K maximum
  output, text and image input (at most 1,024 tokens per image), thinking on
  by default at `high`, efforts low/high/max, `thinking: {type: disabled}` to
  turn it off.
- Default completion is 64K in thinking mode and 128K at `max`. Routes keep at
  least 128K between `autoCompact` and the window.
- In thinking mode `required` and named tool choices return 400 on Chat
  Completions. The `deepseek-thinking` profile already downgrades them to
  `auto`.

Route: `deepseek/deepseek-v4.1-flash` with `deepseek-thinking`. Standalone web
search is not declared, because that capability is only listed for routes
verified against Codex's replay path.

## opencode Go (`opencode-go`)

Sources: https://opencode.ai/docs/go/, https://models.dev/api.json,
https://github.com/anomalyco/models.dev/commit/2858118c,
https://github.com/anomalyco/opencode/pull/48363.

- Added as `deepseek-flash` on 2026-09-10, then renamed to
  `deepseek-v4.1-flash` about 14 hours later. models.dev marks `deepseek-flash`
  deprecated. The live catalog still serves both ids.
- models.dev: 1,000,000 context, 384,000 output, text+image input, reasoning
  low/high/max, tool calls, `interleaved: {field: "reasoning_content"}`.
- Chat Completions only (`https://opencode.ai/zen/go/v1/chat/completions`).
- V4 Flash, V4 Flash Vision Exp and V4 Pro remain listed. OpenCode has not said
  what its V4 Pro serves after 2026-09-14.
- Go allowance for V4.1 Flash is $15 against V4 Flash's $30, with a temporary
  4x usage promotion.
- Related open issue: https://github.com/anomalyco/opencode/issues/48180
  (400 on V4 Flash when `reasoning_content` is echoed with `reasoning_effort`).

Route: `opencode-go/deepseek-v4.1-flash` with `auto-tool-choice`, window
1,000,000 compacting at 850,000.

## OpenRouter (`openrouter`)

Sources: https://openrouter.ai/api/v1/models,
https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
(both public, read 2026-09-11).

- Lists `deepseek/deepseek-v4.1-flash` (canonical
  `deepseek/deepseek-v4.1-flash-20260910`), created 2026-09-10.
- `context_length` 1,048,576; `top_provider` output 384,000; text+image input;
  efforts max/high/low, default high; supports `tools`, `tool_choice`,
  `reasoning_effort`.
- Eleven hosts serve it, DeepSeek among them. Most serve the full 1,048,576
  window with 131,072 to 943,718 output; Io Net caps context at 262,144 and
  SiliconFlow does not list `tools`. The router sets no OpenRouter provider
  preferences, so it does not choose which host answers.
- DeepSeek's endpoint rejects `required` and named tool choices in thinking
  mode, so the route carries `auto-tool-choice`, as the opencode Go route does.
- Not verified: whether OpenRouter returns prior `reasoning_content` to
  DeepSeek on tool-bearing turns. As on the opencode Go, Nous and Command Code
  routes, the router's own replay (`usesNativeChatReasoning` in
  `src/chat-reasoning.mjs`) does not apply here.

Route: `openrouter/deepseek-v4.1-flash` with `auto-tool-choice`, window
1,048,576 compacting at 900,000, which keeps DeepSeek's 128K max-effort
completion and every listed host's output limit below the window.

## Nous Research Portal (`nousresearch`)

Source: https://inference-api.nousresearch.com/v1/models (public).

- Lists `deepseek/deepseek-v4.1-flash` (alias
  `deepseek/deepseek-v4.1-flash-20260910`), created 2026-09-10.
- `context_length` is 1,048,576, but `top_provider` caps context at 262,144
  and output at 235,929. The route uses the served 262,144 window.
- Text+image input; supported efforts max/high/low, default high; supports
  `tools`, `tool_choice`, `reasoning_effort`.
- V4 Flash and V4 Pro ids remain listed.

Route: `nousresearch/deepseek-v4.1-flash`, window 262,144 compacting at
134,000.

## Ollama Cloud (`ollama-cloud`)

Sources: https://ollama.com/search?c=cloud, https://ollama.com/api/tags,
https://github.com/ollama/ollama/issues/18360.

- Not served on 2026-09-11: `library/deepseek-v4.1-flash` returned 404 and the
  cloud API listed only `deepseek-v4-flash:0731` and `deepseek-v4-pro:0813`.
- **Rechecked 2026-09-12: it is served now.** The library publishes
  `deepseek-v4.1-flash:cloud` (digest `72434d5a621f`, 1M context, text and
  image input, tools, 552B MoE backbone), and `https://ollama.com/api/tags`
  lists `deepseek-v4.1-flash` beside the two V4 ids. The cloud catalog shows
  ~7.2K pulls against V4 Flash's 448K, so it landed within the last day.
- Route: `ollama-cloud/deepseek-v4.1-flash`, window 1,048,576 compacting at
  900,000, text and image, efforts low/high/max. It takes the plain
  `ollama-cloud` profile rather than `ollama-cloud-auto-tool-choice`: Ollama
  serves the weights itself, so the DeepSeek API's thinking-mode rejection of
  forced tool choices is not known to apply, and the V4 Flash route on this
  provider already runs without that exception. Move both if a live request
  proves otherwise.
- Not verified live. `ollama-cloud` has no stored credential here, so neither
  `bin/discover-models ollama-cloud` nor `bin/test-model --live` could run, and
  the `:cloud` tag is taken from the library page rather than from a served
  response. Ollama's own `/api/tags` answers under the bare name, and the
  checked-in V4 routes disagree with each other on this point already
  (`deepseek-v4-flash:cloud` against a served `deepseek-v4-flash:0731`,
  `deepseek-v4-pro` against `deepseek-v4-pro:0813`).
- The library page now lists V4 Pro at 1M context while the checked-in route
  declares 524,288; not changed here.

## Command Code (`commandcode`)

Sources: https://commandcode.ai/changelog,
https://api.commandcode.ai/provider/v1/models,
https://commandcode.ai/docs/provider,
https://commandcode.ai/models/deepseek-v4-1-flash.

- CLI v1.53.0 (2026-09-09) added `deepseek/deepseek-v4.1-flash`; the live
  `/models` response lists it as "DeepSeek V4.1 Flash" with a 1,000,000
  context.
- `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` remain listed,
  now named "(latest)", alongside `-flash-fast` and `-flash-vision-exp`. No
  retirement or remap notice.
- Provider API: `https://api.commandcode.ai/provider/v1`, OpenAI Chat
  Completions; `/messages` rejects non-Anthropic models.
- Price matches V4 Flash ($0.15 / $0.60 per M off-peak); available on Go and
  above.
- Not documented: maximum output, effort values, tool_choice or
  `reasoning_content` behavior.
- Rechecked 2026-09-16: Command Code's model page lists Image input under
  Modalities ("V4.1 hybrid-attention reasoning with vision"), and the Provider
  API FAQ says message content is text and images with no per-model pre-gate
  ("Pick a model without vision and the upstream provider returns its own
  error"). The route therefore declares image input. A live image turn through
  the Provider API has not been run.

Route: `commandcode/deepseek-v4.1-flash`, text and image, window 1,000,000
compacting at 850,000. The low/high/max ladder is DeepSeek's documented ladder
for this model, matching the existing Command Code V4 Flash route; it is not
separately documented by Command Code.

## ClinePass (`clinepass`)

Sources: https://docs.cline.bot/getting-started/clinepass,
https://api.cline.bot/api/v1/models, `cline/cline`
`sdk/packages/llms/src/catalog/catalog.generated.ts`.

- ClinePass lists only `cline-pass/deepseek-v4-flash` and
  `cline-pass/deepseek-v4-pro` as of 2026-09-11; its pricing table still shows
  V4 Flash rates.
- Cline's pay-per-use API (not ClinePass) lists `deepseek/deepseek-v4.1-flash`.
- The authenticated ClinePass model list could not be read, so a server-side
  addition is not ruled out.

No route added.

## Qwen Plan (`qwen-plan`)

Not covered in this pass. No Qwen Plan credential was available for live
discovery, and Model Studio's documentation was not reviewed. The checked-in
V4 routes are unchanged.

## Known limitation: stateless tool-result compatibility check

DeepSeek requires every prior assistant turn to carry `reasoning_content`
whenever the request includes `tools`, otherwise it returns 400. The
`stateless tool result` check in `src/compatibility-test.mjs` replays a
`function_call` with no reasoning item, which is exactly that shape, so it is
expected to fail against thinking-mode V4.1 Flash (reproduced on opencode Go in
https://github.com/duolahypercho/codex-router/pull/679). Ordinary Codex turns
store reasoning and the router carries it onto the following assistant turn,
so this does not indicate a failure on real traffic. Live verification and
the native subagent probe have not been run for these routes.

## Native context handling

The Go Flash route keeps `contextWindow: 1000000` and uses `autoCompact: 150000`.
This is a local operational trial, not a claim about a changed provider capacity.
Codex uses the threshold to initiate native auto-compaction, while its 2K
tool-result retention remains a separate client control. The default route has
no `workingInputLimits`: the router applies none of the added ordinary-generation
request bounds, dedicated compaction bounds, or cumulative attempt/input policy.
Removing that metadata does not delete or rewrite the usage ledger.

The generic optional mechanism remains in the registry and transport code for
routes that explicitly configure it. Invalid configured metadata continues to
fail validation, and an explicitly enabled compaction policy continues to fail
closed if an invalid policy reaches the transport boundary.

### Opt-in cumulative native execution boundary

The default Go Flash route does not opt into `workingInputLimits.cumulative`.
The remaining cumulative implementation is available only when a route
explicitly configures `maxAttempts` and `maxInputTokens` in that object. The
registry caps those fields at 60 attempts and 10,000,000 input tokens and permits
the cumulative opt-in only for opencode Go's `deepseek-v4.1-flash`. A guarded
route requires native Codex transport identity; while the default route has no
cumulative metadata, this behavior is dormant. Native OpenAI traffic and
unguarded routes retain their existing behavior.

Identity follows observed Codex CLI 0.159.2 and bundled Desktop
0.159.0-alpha.12.1 transport fields, not agent names,
session names, prompt text, or model-supplied headers. A root execution uses its
stable `(thread_id, turn_id)` pair, including tool round trips and native
`request_kind: compaction` work in the same execution. A later root turn
in the same chat starts a separate allowance. An explicitly classified
`thread_source: subagent`, `subagent_kind: thread_spawn` worker uses `thread_id`
for its lifetime, including a follow-up after completion. The parent lineage is
validated; the shared `session_id` is not a worker discriminator. Missing,
contradictory, unsupported, or ambiguous identities fail closed in this scope.
Bundled Desktop app-server roots omit the analytics `thread_source` or set it to
`agent_created_thread`. These observed shapes require matching session and thread
metadata and transport headers, no worker lineage, and `root_turn_id == turn_id`.
Standalone manual compaction starts a new native turn; automatic compaction can
retain its originating turn. No missing turn or root identity is synthesized.
The checked-in fixture retains only identity fields from actual local native
observations, with agent names omitted.

The router replaces caller-supplied `extra_headers` on this route with its own
vetted identity and existing instance-scoped request ID. LiteLLM carries those
standard headers to the authenticated internal API forwarder. The forwarder
consumes them before its existing `x-codex-*` external-header denylist, and
removes any direct `extra_headers` body field on the guarded route. Native
identity and internal control headers must never reach the external provider.
The router-to-gateway hop does not count as a provider attempt.

The API forwarder is the single admission writer for actual provider sends,
including credential-pool retries and outer router replays. Before each fetch,
it synchronously checks the scope totals including outstanding requests, appends
a reservation to the existing `usage-events.jsonl`, fsyncs it, and consumes the
reservation in memory. No await separates the check/reservation from fetch.
Each row joins the existing router request ID and a monotonic attempt ordinal.
Guarded sends refuse upstream HTTP redirects and retain the
reservation; configure the final API endpoint. They never send to the redirect
target. Unguarded routes preserve their existing redirect behavior.
Failure to read, recover, append, or fsync accounting denies transport with a
terminal `router_resource_budget_exceeded`; that refusal is neither retried nor
failed over. It is not a provider quota signal. The forwarder emits the resource-budget
error code; the installed LiteLLM proxy normalizes it to public
`invalid_request_error` / code `400`, retaining HTTP 400 and the bounded
explanation. Full native CLI loopbacks verify that both exhausted allowance and
unreadable accounting terminate without a router retry or failover.

A reservation charges the final provider-bound request's input estimate. An
outcome records observed input, including cached input, and charges any excess
over the estimate. The larger value is retained; lower reported usage, unknown
usage, failures, cancellations, and possibly-sent requests never refund a
reservation. Outcomes are recorded once. A crashed process's unmatched
reservation stays charged after restart. Duplicate or out-of-order persisted
outcomes and malformed or truncated logs fail closed. Recovery reads at most
256 MiB of log with a 1 MiB maximum row; exceeding either bound also refuses the
guarded route, rather than silently discarding history. Admission records omit
the fields used by completed-request and billed-usage aggregates.

The first successful admission writes an explicit enforcement boundary into the
existing log. Older display telemetry cannot prove historic attempts or assign
them to native executions and is not backfilled. The guarantee starts at this
boundary and relies on retaining this log intact; deleting or replacing it loses
that evidence. The estimate is the existing bytes/3.3 plus bounded-image input
estimate, not an exact tokenizer. Consequently this is a conservative local
estimated-and-observed allowance, **not an exact 10-million-token provider billing
ceiling**. Concurrent requests can have outstanding estimates before their
larger observed counts arrive.

This is intentionally PARTIAL: cumulative assignment-wide enforcement across
replacement workers with new thread IDs remains OPEN. The native identity bridge,
actual tool round-trip continuity, authenticated internal hop, provider-header
absence, persistence, pool retry, restart, and zero-send refusal have local
loopback evidence. Installed activation, host deployment, and live provider
acceptance are separate OPEN rows owned by the delivery task.
