---
document_id: guide.prepare-instance
title: Prepare a Company Instance
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-22
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

Deployment must consume generated company artifacts only after validation.
Those artifacts are disposable build outputs, not an additional source of truth.

## Reference Vercel Runner

The maintained Runner requires these Instance values:

| Value | Purpose |
|---|---|
| `SLACK_CONNECTOR` | Vercel Connect resource identifier for the environment-specific Slack installation |
| `DATABASE_URL` | isolated Neon/Postgres connection used by the `companyos` schema |
| `COMPANYOS_ARTIFACT_GZIP_BASE64` | gzip-compressed immutable Artifact built from clean exact checkouts |
| `COMPANYOS_PUBLIC_BASE_URL` | canonical deployment origin returned by real artifact-publication evidence |
| `COMPANYOS_MODEL_CONFIG_BASE64` | optional Base64 JSON with exact task, profile, and default recipe bindings |
| `COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64` | optional Knowledge-only configuration using the same binding shape; overrides the shared model configuration for Knowledge tasks |
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
    "knowledge.claim-extraction": { "route": "openai-direct", "model": "openai/gpt-5.4-mini" }
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
`companyos-postgres@1.5.0`. It creates the existing control and Knowledge
schemas plus durable compounding leases, receipts, Claim-pair proposals, and
explicit grading requests when the database is initially absent, or upgrades
an older supported manifest in place. Run the separate read-only qualification
after preparation. Do not enable compounding until the model smoke test, all 13
synthetic prompt fixtures, one real authorized extraction, one manual
compounding cycle, and same-cycle retry evidence have passed.

After those gates pass, the maintained Vercel adapter schedules reconciliation,
extraction, and compounding at minutes `0`, `15`, and `30` of each six-hour
window. Vercel injects the Sensitive `CRON_SECRET` as the bearer authorization
for those protected routes. A non-Vercel host MUST bind the same three portable
operations to its own scheduler and SecretRef implementation; database setup
and Core Knowledge do not depend on Vercel Cron.

An artifact publication is served from `/artifacts/<artifact-id>` only after
the exact R3 request passes Core authorization and approval consumption. The
route applies a restrictive content-security policy. Paid-provider effects are
not inferred from a successful Runner deployment; each requires an exact real
Connector binding.
