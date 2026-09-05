---
document_id: guide.prepare-instance
title: Prepare a Company Instance
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-05
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Prepare a Company Instance

Assign a stable Instance ID and environment, then pin the exact Core and
Workspace revisions. Provision environment-specific infrastructure, secrets,
provider bindings, and durable state through the Platform Administrator—not
through committed files.

## Account and project checklist

For the maintained reference setup, the Platform Administrator verifies:

- a Vercel account or team controlled by the company or appointed custodian;
- one identified Vercel project and deployment identity per isolation decision;
- one selected model recipe: Gateway, native Anthropic/OpenAI/Google, a named
  compatible cloud route, or an explicitly reachable proxy/local compatible endpoint;
- accepted provider billing and data terms plus confirmed access to the exact
  selected model;
- a Neon/Postgres account and project when durable state is required;
- separate production and non-production credentials and state unless an
  explicit risk decision permits sharing;
- GitHub Actions secrets for deployment credentials and read-only access to the
  pinned Core; and
- provider accounts and installations for every declared connection, with
  minimum scopes, billing/recovery ownership, and a revocation path.

Vercel and Neon/Postgres are the reference providers. An alternative is valid
only when it preserves the Company Instance contracts for isolation, secrets,
provenance, evidence, state guarantees, observability, and rollback. An
`authoring-only` Workspace does not provision these accounts.

## Maintained first-installation profile

For a company that explicitly requests the complete Slack starter, use
`companyos setup --profile vercel-neon-slack` rather than assembling provider
commands from this Guide. Its read-only plan names the exact GitHub owner and
repository, Vercel scope and project, Neon resource, Slack connector, model,
create-or-adopt choice, cost or consent boundary, and rollback responsibility.
The plan hash must be confirmed before any provider mutation.

The state machine pauses for browser login and provider consent, derives the
consenting human's canonical Slack team and user IDs without retaining the
short-lived credential, and moves the Workspace from `authoring-only` to one
Tool-free supervised starter through a distinct preview and independently
reviewed pull request. It then builds one immutable Artifact and requests a
separate production-candidate confirmation before deployment.

Run `companyos verify-live --state <file>` after the human sends the requested
nonce in Slack. Success proves the exact deployment health and the persisted
human and assistant entries in Neon for scope `live-starter-instance`. It does
not certify a generic Effect Lane, an unattended workflow, or `enforced`
readiness.

Before release, run `companyos build` against clean exact repository checkouts
and a non-secret Instance declaration. The build records the Core and Workspace
commits, Workbench version, Workspace and Capability catalog hashes, resolved
ToolSet hash, roster, scoped agent material, and exact Connector bindings.
Production and non-production should not share secrets or state without an
explicit risk decision.

When a maintained live Connector is required, declare its installation under
the optional top-level `connectors` list. Keep exact resources and destinations
in the Instance declaration and reference credentials only by environment
SecretRef. For example:

```yaml
connectors:
  - id: records
    connector: oregano/company-records
    connector_version: 0.1.0
    configuration:
      configuration_ref: env:COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64
  - id: work-items
    connector: oregano/monday-work-items
    connector_version: 0.1.0
    configuration:
      token_ref: env:MONDAY_API_TOKEN
      api_version: dev
      actor_id: external-agent-member-id
      resources:
        - id: sprint-test-board
          board_id: "10000000001"
          permission: read-write
          fields:
            status: status
        - id: sprint-replay-output-board
          board_id: "10000000002"
          permission: read-write
          fields: {}
  - id: communication
    connector: oregano/slack-communication
    connector_version: 0.1.0
    configuration:
      destinations:
        - id: sprint-test-channel
          account_id: T00001
          kind: channel
          channel_id: C00001
        - id: sprint-replay-output-channel
          account_id: T00001
          kind: channel
          channel_id: C00002
        - id: sprint-direct-alex
          account_id: T00001
          kind: direct-message
          user_id: U00001
sprint_runtimes:
  - definition: weekly-delivery
    agent: sprint
    execution: active-capable
    service_principal: companyos:instance:sprint
    participant_identity_prefix: monday:account:
    direct_destinations:
      slack:T00001:U00001: sprint-direct-alex
    replay:
      message_projection: sprint-messages
      test_publication:
        test_only: true
        publisher_agent: sprint-replay-publisher
        communication_binding: sprint-replay-output-channel
        work_item_binding: sprint-replay-output-board
        work_item_id: "10000000003"
        forbidden_channel_ids: [C00001]
        forbidden_board_ids: ["10000000001"]
    work_item:
      resource_binding: sprint-test-board
      rollover_field: sprint
      readiness_field: status
```

The declaration must never contain a token, signing secret, database URL, or
other resolved credential. A Capability binding and Agent grant are still
required independently; Connector configuration alone grants no authority.
An active Sprint Agent that performs briefings needs both the normal
`oregano:work-items/update` Tool and the
`oregano:work-items/confirmed-update` Tool. The latter accepts only the exact
active human subject of the frozen reversible proposal. Rollover additionally
needs `oregano:work-items/batch-update`, the `work-item.batch-update`
Capability, an exact read-write resource binding, and ordinary R3 approval.
Set `execution: shadow-only`, omit every provider-effect Tool grant and
Capability binding, and omit `work_item` for a structurally effect-free Shadow
Instance. Keep the Slack Connector's exact destination metadata so compilation
can freeze the reviewed channel and recipients; Connector configuration alone
grants no Tool authority. The Runner accepts such an Artifact only in
`COMPANYOS_SPRINT_RUNTIME_MODE=shadow` or `disabled` and rejects `active`
before constructing a provider dispatcher. Use `execution: active-capable`
(the backward-compatible default) only when the Agent has the reviewed
communication and optional work-item grants and the Instance binds them.

`replay.message_projection` is optional. When present, Workbench requires the
exact projection to have record type `communication-message` and to expose
`message_id`, `team_id`, `author_id`, `thread_id`, `text`, and `occurred_at`.
The authenticated Sprint operator may then replay an explicit historical date
range with a controlled clock. Provider authors still resolve only through
tenant-scoped canonical roster principals; message content cannot choose an
Agent or grant authority. The maintained hosted replay is proof-only: it
stores deterministic Sprint events, states, intents, outcomes, and source
version lineage in `companyos_records`, while refusing every compiled live
Slack or work-item binding. Publishing a reviewed result to a test destination
is a separate Capability-controlled operation and is never implied by replay.
When `test_publication` is present, `publisher_agent` must be a dedicated Agent
with only the reviewed `oregano:communications/publish` and
`oregano:work-items/comment` grants. It must not be the default Agent or appear
in `agent_bindings`, and no Agent handoff may target it. Dynamic participant
and work-item values are escaped as provider data before the report crosses a
provider-markdown boundary. The communication binding must resolve to one exact test
channel; the work-item binding must resolve to one exact read-write test board;
and `work_item_id` identifies the single test-board item that receives report
comments. `forbidden_channel_ids` and `forbidden_board_ids` name protected live
provider resources. Workbench rejects test/live equality by logical binding and
physical provider id. The operator first runs `replay`, reviews its
`output_digest`, then calls `publish-replay` with that exact digest. The Runner
recomputes the report and performs no effect if any input has changed. Repeating
the same accepted digest reuses the same effect claims and provider receipts.

The maintained Vercel Runner also verifies the Artifact environment against
Vercel's trusted deployment identity. A `production` deployment accepts only a
`production` Artifact, a `preview` deployment accepts only a `preview`
Artifact, and `development` accepts only `development`. Outside an explicit
Vercel environment the Runner preserves the production-only default. Never
relabel or reuse an Artifact across environments; rebuild it from the exact
Core, Workspace, and non-secret Instance declaration instead.

Deployment must consume generated company artifacts only after validation.
Those artifacts are disposable build outputs, not an additional source of truth.

## Reference Vercel Runner

The maintained Runner requires these Instance values:

| Value | Purpose |
|---|---|
| `SLACK_CONNECTOR` | Vercel Connect resource identifier for the environment-specific Slack installation; it can also back a Slack Record Source when its Instance binding selects `credential_provider: vercel-connect-app` |
| `COMPANYOS_SLACK_AGENT_VIEW` | optional exact `true` opt-in for Slack Agent View; requires Agent experience plus `chat:write` on the same installed Slack app and defaults to disabled |
| `DATABASE_URL` | isolated Neon/Postgres connection used by the `companyos` schema |
| `COMPANYOS_ARTIFACT_GZIP_BASE64` | gzip-compressed immutable Artifact built from clean exact checkouts |
| `COMPANYOS_STAGE0_CONFIG_GZIP_BASE64` | optional Preview-only, gzip-compressed non-secret qualification scope for exact test resources and destinations |
| `COMPANYOS_STAGE0_SECRET` | optional Sensitive bearer protecting the Preview-only Stage-0 qualification route |
| `COMPANYOS_PUBLIC_BASE_URL` | canonical deployment origin returned by real artifact-publication evidence |
| `COMPANYOS_MODEL_CONFIG_BASE64` | optional Base64 JSON with exact task, profile, and default recipe bindings |
| `COMPANYOS_SPRINT_RUNTIME_MODE` | hosted Sprint kill switch: `disabled` (default), `shadow`, or `active` |
| `COMPANYOS_SPRINT_OPERATOR_SECRET` | Sensitive bearer protecting Sprint inspect/open actions |
| `COMPANYOS_SPRINT_DEFINITION_ID` | optional exact compiled Sprint definition when an Instance contains more than one |
| `COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64` | optional Knowledge-only configuration using the same binding shape; overrides the shared model configuration for Knowledge tasks |
| `COMPANYOS_KNOWLEDGE_CYCLE_BUDGET_USD` | optional productive-maintenance cycle ceiling; defaults to `5` USD |
| `COMPANYOS_KNOWLEDGE_DAILY_BUDGET_USD` | optional UTC-day productive-maintenance ceiling; defaults to `10` USD |
| `COMPANYOS_GRANOLA_SOURCE_CONFIG_BASE64` | Secret-free active Source requirement and binding used by the maintained Granola ingestion and compounding adapter |
| `GRANOLA_API_KEY` | Sensitive workspace API key resolved only inside the Granola provider call |
| `CRON_SECRET` | Sensitive bearer secret protecting scheduled Knowledge qualification, reconciliation, extraction, and compounding operations |
| `COMPANYOS_MODEL_ROUTE` | simple or compatibility binding to one Core recipe route |
| `COMPANYOS_MODEL` | exact route-prefixed `provider/model` identifier for the selected recipe |
| `ANTHROPIC_API_KEY` | Sensitive runtime secret for `anthropic-direct` |
| `OPENAI_API_KEY` | Sensitive runtime secret for `openai-direct` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Sensitive runtime secret for `google-direct` |
| `OPENAI_COMPATIBLE_API_KEY` | Sensitive runtime secret for `openai-compatible` |
| `COMPANYOS_OPENAI_COMPATIBLE_BASE_URL` | explicit API base URL for `openai-compatible` |
| `COMPANYOS_AGENT_ID` | Agent selected from the Artifact when it contains more than one Agent |

Named compatible cloud routes use their documented default endpoint and one
Sensitive runtime secret: `openrouter` uses `OPENROUTER_API_KEY`, `deepseek`
uses `DEEPSEEK_API_KEY`, `groq` uses `GROQ_API_KEY`, `together` uses
`TOGETHER_API_KEY`, `minimax` uses `MINIMAX_API_KEY`, `zhipu` uses
`ZHIPUAI_API_KEY`, `moonshot` uses `MOONSHOT_API_KEY`, `mistral` uses
`MISTRAL_API_KEY`, and `nvidia` uses `NVIDIA_API_KEY`. `OPENROUTER_BASE_URL`
may override the OpenRouter endpoint.

The explicit proxy/local routes are `litellm`, `ollama`, and `llama-server`.
They use `LITELLM_BASE_URL`, `OLLAMA_BASE_URL`, and
`LLAMA_SERVER_BASE_URL` respectively, with documented localhost defaults.
Their corresponding API-key variables are optional. A hosted runtime must use
an endpoint reachable from that runtime; its `localhost` is not the operator's
computer. The generic `openai-compatible` route remains the escape hatch for a
provider without a named recipe.

The Slack Connector trigger path is `/api/webhooks/slack`. Health is
`/api/health`. A release is not accepted until health reports the expected
Core commit, Workspace commit, Artifact hash, resolved ToolSet hash, model
route, and model; an
authorized roster member reaches the selected Agent; and an unknown identity
is blocked before model invocation.

The hosted Sprint operator path is `POST /api/sprint/operator`; it supports
`inspect`, `open`, proof-only `simulate`, and separately controlled replay and
test-publication actions, and requires `COMPANYOS_SPRINT_OPERATOR_SECRET`.
`GET /api/sprint/timers` and `GET /api/sprint/intents` are bounded wake-up
routes protected by `CRON_SECRET`. The immutable Workspace schedule, not the
hosting cron, decides whether work is due. Leave the runtime `disabled` until
the Artifact contains the reviewed Sprint declaration, schedule, templates,
Agent, service principal, exact participant identity namespace, destination
bindings, and fresh Record projections. Use `shadow` before `active`; shadow
persists digest evidence but sends no message and changes no work item.
A schedule that remains `blocked` in the Workspace may be exercised only in
`shadow` so Stage 0 can qualify the compiled timing without creating an effect.
`active` workers continue to fail closed until that exact schedule declaration
is explicitly active.

The reviewed Sprint configuration may independently bind
`weekly.monday_handoff_trigger` and `weekly.weekday_digest_trigger` to immutable
schedule entries and their Workspace-owned `monday_handoff` or
`weekday_digest` templates. `weekly.readiness_weekday` additionally requires
the weekday digest, planning states, required fields, and the Workspace-owned
`direct_question` template. Before any due weekly timer,
the Runner refreshes the twice-stabilized work-item projection while retaining
the Sprint's frozen participant scope. Bind every participant identity to one
exact direct-message destination before enabling readiness questions.

For an operator-reviewed Monday hand-off test, keep the runtime
`execution: shadow-only` and add `test_publication` with `test_only: true`, one
exact communication binding, and a non-empty `forbidden_channel_ids` list that
contains the live Sprint channel id. The Sprint Agent must resolve
`oregano:communications/publish`, but ordinary Shadow workers still execute no
provider effect and the conversational model cannot see the operator-only
grant. First call `simulate`; then pass only its exact output digest
and stored Monday hand-off intent id to `publish-simulation`. The host derives
the Agent, Tool, template, message content, and test destination from the
compiled Artifact and rejects any changed digest or live-channel alias.

The checked-in Vercel reference wakes the Sprint workers once per minute.
Vercel currently supports that frequency only on plans with per-minute Cron;
Hobby Cron is limited to once per day with hourly precision. A Company
Instance whose hosting plan cannot support the reviewed wake-up frequency MUST
either bind a separately authenticated scheduler or remain disabled. Verify
the current host limits, usage price, and selected plan in the Instance change
plan before Stage 5E; never silently weaken the company schedule to make a
deployment pass. See Vercel's current
[Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
and [Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Bind `sprint.coordination` under `tasks` in
`COMPANYOS_MODEL_CONFIG_BASE64` when the interactive Sprint Agent needs an
exact model recipe. Core stores only that provider-neutral task name; the
Instance selects the provider and model. The initial maintained profile uses
the records reconciliation scheduler for Monday freshness and Slack for
interactive submissions. Do not treat Monday card chat or board webhooks as
available until a later separately qualified extension supplies them.

Enabling `COMPANYOS_SLACK_AGENT_VIEW=true` does not create another Slack app or
another CompanyOS Agent. The same `slack/oregano` installation remains the
transport identity, and the existing AgentResolver still chooses the internal
Agent only after canonical roster authorization. Before enabling the value,
turn on Agent experience for that Slack app and retain the existing
`chat:write` grant. The maintained Runner uses Slack Agent Sessions for the
native `Working` lifecycle status and streams ordinary conversational answers
without granted Company business Tools through Slack's native streaming API.
For Company business-Tool-bearing, required-grounding, Builder, approval, and
effect-bearing turns, provisional model prose remains buffered while Slack
shows output-free Tool progress; the exact validated final presentation then
streams in native chunks. Explicit pending approval or Builder-confirmation
results leave the Agent Session suspended. Setup verification remains one exact
buffered proof response. Also subscribe the
existing Slack connector
to `agent_session_stopped`; this adds no content scope, but lets Slack deliver a
user's native stop request. The Runner passes the resulting cancellation signal
to model execution. A DM subscribed under the earlier Assistant View remains
one durable CompanyOS conversation, while Agent Session status, reply, and a
short-lived exact stop bridge use the accepted inbound root message required by
Slack. A stop cancels unfinished generation; it does not undo a Tool effect that
already completed. New sessions use the first line of the accepted root
message as a deterministic title; Slack users can rename, pin, and archive them.
This does not invoke a model or widen data access. The initial mode does not
require suggested prompts, context events, Slack MCP, feedback controls, or new
Tool grants. Roll
back by removing the value and redeploying before disabling the provider-side
Agent experience and stop-event subscription.

`POST /api/stage0/qualification` is an optional test-only route. It must exist
only in a protected Preview deployment with a `preview` Artifact. Use `inspect`
before any effect. Plan and apply actions are digest-bound; the Monday action
must restore the prior test value, and Slack actions must name only the exact
test channel and approved DM destination. Remove or disable the Stage-0 bearer
and configuration after qualification. Never bind production boards or normal
operating channels to this harness.

For `vercel-ai-gateway`, the Runner authenticates through the Vercel deployment
identity and consumes no provider API key. Direct recipes use the official
Anthropic, OpenAI, or Google adapter and bypass AI Gateway. The Platform
Administrator creates a dedicated provider key and enters it only in the
runtime host's secret UI under the recipe's documented environment name.
Vercel is acting only as runtime host and secret store in the maintained
profile. Setup observes the variable name, presence, and Sensitive
classification, never its value. Never place a provider key in chat, a command
argument, Git, the Workspace, the Artifact, or setup state.

`COMPANYOS_MODEL_CONFIG_BASE64` encodes this provider-neutral shape:

```json
{
  "version": 1,
  "default": { "route": "anthropic-direct", "model": "anthropic/claude-sonnet-4-6" },
  "profiles": {
    "utility": { "route": "anthropic-direct", "model": "anthropic/claude-haiku-4-5-20251001" },
    "reasoning": { "route": "anthropic-direct", "model": "anthropic/claude-sonnet-4-6" },
    "deep": { "route": "anthropic-direct", "model": "anthropic/claude-opus-4-7" }
  },
  "tasks": {
    "knowledge.working-synthesis": {
      "route": "anthropic-direct",
      "model": "anthropic/claude-sonnet-4-6",
      "maxOutputTokens": 4000,
      "timeoutMs": 240000,
      "retries": 0
    }
  }
}
```

Task bindings override profiles, and profiles override the default. The simple
`COMPANYOS_MODEL_ROUTE` and `COMPANYOS_MODEL` pair remains supported. With no
explicit binding, a present Anthropic key selects the documented Anthropic
profile default, then a present OpenAI key selects the OpenAI default, and the
resolver otherwise uses Vercel AI Gateway. A resolved request never silently
fails over to another provider. Run the model smoke test after changing a
recipe, key, endpoint, or model.

`COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64` uses the same JSON shape and is
compiled against all 13 generative prompts in Core Prompt Registry `2.0.0`. It is the
right place to pin a direct provider for retained evidence without changing the
interactive Agent model. The maintained Anthropic task-tier preset uses Haiku
4.5 for utility classification and expansion, Sonnet 4.6 for extraction and
evidence reasoning, and Opus 4.7 for explicit deep synthesis. Anthropic is not
an embedding or cross-encoder reranking provider; configure those capabilities
separately or retain the declared lexical fallback.
The prompt dispatcher validates exact prompt, input-schema, and output-schema
identities before execution. Cross-encoder reranking remains a separate
capability and is not part of the 13 task bindings.

Database preparation targets additive manifest
`companyos-postgres@1.9.0`. It creates the existing control and Knowledge
schemas, the provider-neutral Record Source and Sprint schema, durable compounding state, policy-bound model-result cache, spend
reservations, execution ledger, and derived Retrieval V3 projection and
qualification tables when the database is initially absent, or upgrades
an older supported manifest in place. Run the separate read-only qualification
after preparation. Do not enable compounding until the model smoke test, all 13
synthetic prompt fixtures, one real authorized extraction, one manual
compounding cycle, same-cycle retry evidence, and cross-cycle unchanged-result
reuse have passed.

### Retrieval V3 non-production lane

A Neon branch is an acceptable staging StateStore boundary. It is not the
whole non-production Instance. Record one qualification receipt proving all of
the following before Retrieval V3 is activated anywhere:

- the Neon project or branch identity differs from production;
- the runtime project or deployment scope differs from production;
- SecretRefs resolve from a distinct non-production namespace;
- Slack or another communication binding is distinct and cannot receive normal
  production traffic;
- every Source binding has a distinct non-production identity and qualified
  read scope; and
- model execution has an explicit small cycle or UTC-day budget.

Prepare and read-only verify schema `1.9.0` on that Instance. Build the derived
projection from the active Handbook snapshot and current durable Brain
frontier, stage it, and verify its deterministic hash and complete Unit count.
Do not activate it during the build step. Run KnowledgeBench against Retrieval
V2 and V3 with the same authorized subjects, including negative ACL cases, and
persist the payload-free baseline and shadow comparison. The candidate must
have zero authorization leakage and citation errors and no recall, rank, or
authority-label regression.

Then exercise Current Brief, the V3 Answer Envelope, Open Loops, Meeting Prep,
backup restoration, and rollback. The Knowledge Doctor must report no failed
gate before an accountable operator creates the separate activation receipt.
The repository implementation creates none of the external resources or real
qualification evidence automatically.

### Oregano HQ internal production-canary lane

The strict non-production lane remains the reusable default for customer
Instances. Oregano HQ MAY instead use the explicit internal-dogfood production
canary contract. This exception avoids a duplicate Vercel project, Slack app,
Granola binding, and model-secret namespace, but it does not skip the StateStore
rehearsal or retrieval gates. It requires all of the following:

- one point-in-time Neon branch from the exact production branch, with
  `companyos database prepare` and `companyos database verify` succeeding on
  that branch before production migration;
- provider backup evidence and an accepted additive-schema rollback posture;
- one exact verified production V3 projection that is not served while the
  benchmark and shadow gates run;
- a payload-free production shadow in which V2 remains the returned response;
- zero-leak ACL negatives, exact citation membership, a passing KnowledgeBench,
  healthy Source evidence, and a pre-activation Knowledge Doctor report;
- an explicit internal Agent allowlist and no external-user traffic; and
- a tested V2 runtime fallback plus accountable operator risk acceptance.

The production Runner uses three fail-closed bindings:

| Value | Meaning |
|---|---|
| `COMPANYOS_KNOWLEDGE_RETRIEVAL_MODE` | `v2` by default, `v3-shadow` to execute but never serve V3, or `v3-canary` to serve the qualified candidate. Any other value falls back to V2. |
| `COMPANYOS_KNOWLEDGE_V3_PROJECTION_HASH` | Exact 64-character verified projection identity. A missing or malformed identity falls back to V2. |
| `COMPANYOS_KNOWLEDGE_V3_AGENT_IDS` | Comma-separated internal Agent allowlist. A missing, malformed, or non-matching allowlist falls back to V2. |

`v3-shadow` may read the exact verified inactive projection and persists only
query, authorization-context, result-digest, count, overlap, and failure
digests. It returns the exact V2 result. `v3-canary` requires that same exact
projection to be active. Candidate search failure automatically serves V2 with
an explicit degradation. Projection activation itself requires the exact
persisted `qualified-for-explicit-activation` receipt; setting environment
variables cannot activate a projection.

After those gates pass, the maintained Vercel adapter schedules reconciliation
at minute `0` and extraction at minute `15` of each six-hour window, plus one
resumable maintenance batch nightly at `02:00` UTC. Vercel injects the Sensitive
`CRON_SECRET` as the bearer authorization
for those protected routes. A non-Vercel host MUST bind the same three portable
operations to its own scheduler and SecretRef implementation; database setup
and Core Knowledge do not depend on Vercel Cron.

An artifact publication is served from `/artifacts/<artifact-id>` only after
the exact R3 request passes Core authorization and approval consumption. The
route applies a restrictive content-security policy. Paid-provider effects are
not inferred from a successful Runner deployment; each requires an exact real
Connector binding.
