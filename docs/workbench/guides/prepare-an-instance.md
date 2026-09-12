---
document_id: guide.prepare-instance
title: Prepare a Company Instance
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-11
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

::: implementation-example

For a fresh Slack starter, use the release installer and `companyos setup`.
The CLI discovers accounts, requires the explicit OpenAI-or-Anthropic choice,
and shows one editable resource, cost, region and responsible-person summary.
It uses the selected direct recipe and its maintained agent model. Other models
or providers are available only on request. The provider key is entered in
Vercel Sensitive Production settings through the existing browser action. One decision covers creation and the
first production deployment. Vercel Pro/Enterprise is detected automatically;
Hobby needs a human billing action. Oregano manages schedules.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

After provider consent and Slack identity resolution, the initializer creates a
complete supervised operating Workspace at `0.1.0` and verifies its initial
commit. No activation PR, authoring-only publication or second deployment
confirmation belongs in this path. The same release payload supplies CI's
Workbench, avoiding another developer dependency install for the initial check.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

::: implementation-example

An ordinary first Slack message is correlated with the real model response and
persisted conversation for the exact Artifact and human. The CLI invokes
`companyos verify-live` before completion. It proves `live-starter-instance`,
not general unattended authority. Fresh cold live timing remains to be qualified.

See the [maintained host profile](../../operations/maintained-host-profile.md).

:::

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
Executable work belongs in declared Workflows and `workflow_bindings`.
The retired `sprint_runtimes` declaration is rejected with a migration message.
Rebuild from the migrated Workspace before activation. See
[Workflow operation](../../operations/workflow-engine.md) for the general
contract and the [Vercel runner guide](../../operations/vercel-workflow-runner.md)
for the concrete hosting setup.

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
| `COMPANYOS_PUBLIC_BASE_URL` | canonical deployment origin returned by real artifact-publication evidence |
| `COMPANYOS_MODEL_CONFIG_BASE64` | optional Base64 JSON with exact task, profile, and default recipe bindings |
| `COMPANYOS_KNOWLEDGE_CYCLE_BUDGET_USD` | optional productive-maintenance cycle ceiling; defaults to `5` USD |
| `COMPANYOS_KNOWLEDGE_DAILY_BUDGET_USD` | optional UTC-day productive-maintenance ceiling; defaults to `10` USD |
| `COMPANYOS_GRANOLA_SOURCE_CONFIG_BASE64` | Secret-free active Source requirement and binding used by the maintained Granola ingestion and compounding adapter |
| `GRANOLA_API_KEY` | Sensitive workspace API key resolved only inside the Granola provider call |
| `CRON_SECRET` | Sensitive bearer secret protecting retained scheduled runtime operations |
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

Use the declared workflow operator, timer, and Records worker paths described
in the [Vercel runner guide](../../operations/vercel-workflow-runner.md).
Retired Sprint and Stage-0 routes are no longer available. A successful source
build does not activate a company schedule or replace a hosted acceptance test.

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

::: implementation-example

Database preparation targets `companyos-postgres@3.0.0` and qualification
receipt version 2. It creates or upgrades the 15 control/Workflow and 11 Records
tables. Handbook Markdown requires no database projection, vector extension,
Knowledge model task, source binding or activation. Run the separate read-only
qualification after preparation.

See the [maintained implementation](retire-knowledge.md).

:::

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
