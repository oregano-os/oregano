---
document_id: guide.prepare-instance
title: Prepare a Company Instance
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-09
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Prepare a Company Instance

Prepare the non-secret build declaration at `.companyos/instance.yaml` in the
Company Workspace. This allowed, security-reviewed configuration sits beside
`governance.yaml` and `compatibility.yaml`; no `instances/` directory is used.
Commit it before building. `companyos build` discovers it automatically, and
alternative input paths are not supported. See
[Workspace Instance Configuration](../../reference/instance-configuration.md)
for the format, external dependencies and migration checklist.

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

For a fresh Slack starter, use the release installer and `companyos setup`.
The CLI discovers accounts, requires the explicit OpenAI-or-Anthropic choice,
and shows one editable resource, cost, region and responsible-person summary.
It uses the selected direct recipe and its maintained agent model. Other models
or providers are available only on request. The provider key is entered in
Vercel Sensitive Production settings through the existing browser action. One decision covers creation and the
first production deployment. Vercel Pro/Enterprise is detected automatically;
Hobby needs a human billing action. Oregano manages schedules.

After provider consent and Slack identity resolution, the initializer creates a
complete supervised operating Workspace at `0.1.0` and verifies its initial
commit. No activation PR, authoring-only publication or second deployment
confirmation belongs in this path. The same release payload supplies CI's
Workbench, avoiding another developer dependency install for the initial check.

An ordinary first Slack message is correlated with the real model response and
persisted conversation for the exact Artifact and human. The CLI invokes
`companyos verify-live` before completion. It proves `live-starter-instance`,
not general unattended authority. Fresh cold live timing remains to be qualified.

Resume current schema-5 sessions with `companyos setup`. The explicit
`--profile` installer and state versions 1–4 are retired and fail before provider
work. Existing installations use reviewed Workspace and Instance changes; they
are not adopted through a fresh setup session. Select the supported model
provider during the standard setup review.

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
      actor_id: "700007"
      credential_identity:
        account_id: "300003"
        member_id: "700007"
        kind: external_agent_member
        external_agent_id: "900001"
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
For hosted Monday access, populate `credential_identity` from the completed
external-Agent qualification receipt, using the authenticated member ID for
`actor_id`. These fictional IDs are examples, not defaults. The host requires
this identity on every retained Artifact and rechecks the same credential's
account, Agent subject, active board, minimum access and mapped columns before
each call. Missing or changed identity blocks access; it is never inferred from
the token. Alternative hosts must install equivalent qualification at their
trusted Connector construction boundary.
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
| `CRON_SECRET` | Sensitive bearer secret protecting the retained Builder, Records and Sprint jobs |
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

To test Friday Close communication from the same reviewed proof, call
`publish-friday-close-simulation` with the identical scenario input and exact
output digest. Do not pass intent ids, content, destination, or thread data.
The host resolves the succeeded reminder, chase, and report intents, publishes
the reminder as the root message, and forces chase and report to reuse its real
Slack thread receipt. Each step is independently idempotent, so retrying after
a partial failure does not duplicate already successful messages. The action
does not publish Retro and cannot select a live destination.

The checked-in Vercel reference wakes the Sprint workers once per minute.
The maintained installer requires Vercel Pro or Enterprise for this frequency;
Hobby Cron is limited to once per day with hourly precision. Outside this
installer, a Company
Instance whose hosting plan cannot support the reviewed wake-up frequency MUST
either bind a separately authenticated scheduler or remain disabled. That
requires separate configuration and qualification; the maintained installer
does not offer it as a Hobby alternative. Verify
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
    "agent.chat": {
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

Database preparation targets `companyos-postgres@3.0.0` and qualification
receipt version 2. It creates or upgrades the 15 control/Workflow and 14 Records/Sprint
tables. Handbook Markdown requires no database projection, vector extension,
Knowledge model task, source binding or activation. Run the separate read-only
qualification after preparation.

For an existing Instance, retire obsolete Knowledge state through
[Retire Knowledge](retire-knowledge.md). Preparation and health do not perform
the destructive retirement. Preserve the shared database, model credentials and
`CRON_SECRET` required by Builder, Records and Sprint. Generic task/profile
selection follows [Model recipes](../../specifications/model-recipes.md).

An artifact publication is served from `/artifacts/<artifact-id>` only after
the exact R3 request passes Core authorization and approval consumption. The
route applies a restrictive content-security policy. Paid-provider effects are
not inferred from a successful Runner deployment; each requires an exact real
Connector binding.


For generic executable workflows, follow
[Hosted Workflow Engine Operations](../../operations/workflow-engine.md).
The Instance Administrator verifies exact activation, non-secret historical
Records snapshots, provider account/recipient checks, source cutoff coverage and
real human decision evidence. `companyos onboard` keeps these as external
Instance verification; passing local validation or the Tool-free starter check
cannot establish workflow execution readiness.
