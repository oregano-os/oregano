---
document_id: guide.operate-knowledge-provider
title: Operate the Knowledge Provider
kind: guide
status: building
authority: canonical
language: en
updated: 2026-08-25
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.1
    - architecture.company-instance
---

# Operate the Knowledge Provider

Use the existing Company Instance `DATABASE_URL`. Build the Knowledge Bundle,
stage it, verify its counts, and activate its exact hash. Confirm a known
lexical and hybrid query, a zero-result query, an exact `get`, and a bounded
traversal before granting operating use. Provider health must state whether the
optional vector index is available and name any lexical degradation.

## Model runtime operation

All direct Agent and Knowledge language-model calls resolve through the Core
model-recipe registry. The optional `COMPANYOS_MODEL_CONFIG_BASE64` value binds
exact tasks, profiles, and a default recipe/model. The Knowledge-only
`COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64` value accepts the same shape and wins
for registered Knowledge prompts, while the simple `COMPANYOS_MODEL_ROUTE` and
`COMPANYOS_MODEL` pair remains supported. A recipe references provider
credential and optional base-URL environment names but never contains their
values. Task bindings override profile bindings and the default. No request
silently fails over across providers.

The maintained direct-Anthropic preset maps `utility` to
`anthropic/claude-haiku-4-5-20251001`, `reasoning` to
`anthropic/claude-sonnet-4-6`, and `deep` to
`anthropic/claude-opus-4-7`. The maintained background
`knowledge.working-synthesis` task is an explicit exception: it stays a
quality-sensitive `deep` task but uses Sonnet with 4,000 output tokens, no
provider retry, and a 240-second call boundary so one hosted continuation can
finish or fail cleanly before its 300-second host lease. Interactive cited
synthesis retains Opus. The Prompt Registry maps every task to one of those
tiers and exact task overrides remain possible. Embedding and optional
cross-encoder reranking are separate capability adapters and are never
fabricated from an Anthropic language model.

Working Synthesis never sends an unbounded Subject to one call. Current Claims
are sorted by stable identity into groups of at most 40. Each group receives a
separate cached result and receipt; the last group merges all prior cached
components deterministically into one immutable synthesis version.

The maintained serverless schedule advances those durable continuations every
15 minutes only during the 02:00–05:59 UTC nightly window. It does not run
model maintenance every 15 minutes throughout the day. A long-running host can
drive the same portable cycle until completion in one background worker.

Prompt Registry `2.0.0` compiles 13 generative Knowledge tasks. Runtime
dispatch requires the exact prompt version and content hash plus the declared
input and output schema IDs; any substitution fails before the provider call.
The Runner validates bounded structured task input, renders the task-specific
user instruction, and quotes numbered source evidence as untrusted JSON.
Reranking is never compiled as a language-model task.

Named compatible recipes use one shared transport but keep separate routes,
credential references, default endpoints, model namespaces, and capability
declarations. Their advisory model lists do not form a hard allowlist: a
provider-native model ID remains valid under its route namespace. Ollama,
llama-server, and LiteLLM must be selected explicitly and must be reachable
from the runtime; their optional credentials are not replaced with synthetic
keys.

After changing a recipe, model, endpoint, or credential, call
`POST /api/knowledge/model/smoke-test` with the maintained scheduler
authorization. The route performs one bounded structured-output call and
returns only the distinct routes and models, response model identifiers,
adapter digests, test identity, time, and latency. It sends one synthetic
structured-output request to each distinct configured Knowledge language model.
It does not activate a model profile, approve data egress, send source evidence,
or create Handbook authority. Knowledge authorization still completes before
every real evidence block is sent to a model.

Then call `POST /api/knowledge/model/qualification`. The protected operation
runs every current synthetic Prompt Registry fixture through its exact task
binding and returns only route/model identities, receipt IDs, and precision,
recall, and F1 metrics. It does not send company evidence. A smoke test proves
transport readiness; fixture qualification proves the configured models can
satisfy the maintained prompt contracts. Both must succeed after a model,
prompt, route, or provider change.

## Productive compounding operation

`GET` or `POST /api/knowledge/compounding` advances one bounded maintenance cycle for the
exact active company source binding. The cycle identity combines the productive
Compounding contract, exact prompt and model bindings, and a digest of the
current authorized Claim and grading-request frontier. It therefore resumes
across wall-clock windows until complete and starts a new cycle when its inputs
or execution contract change. The operation authorizes the company
principal and policy before loading Claims. It persists leases, resumable phase
receipts, semantic duplicate proposals, Claim-relation proposals, conflict
proposals, immutable working-synthesis versions, and explicit grading results.
It never accepts a proposal, mutates a canonical Claim, or writes the Handbook.
The portable default processes one model-backed work item per phase on each
invocation so common serverless hosts remain below their execution limit. Each
partial phase writes its next cursor; a long-running host may pass a larger
explicit budget through its own adapter. Receipts expose the phase's aggregate
work count without exposing Claim identities or content. The maintained Vercel
adapter processes five pair candidates but only one deep-synthesis subject per
invocation. Contract `2.2.0` uses different gates for different work: exact
normalized duplicates are deterministic, ambiguous duplicates require at least
`0.45` lexical overlap, relations require `0.20`, and conflicts require the same
Claim kind plus `0.15`. Policy and subject must match for every pair. Expensive
relation and synthesis work first passes the cached `knowledge.triage` task.

Every productive task result is content-addressed by its prompt, schema,
candidate-rule, model, input, evidence-digest, authorization, data-class, and
access-policy identities. An authorized cache hit reuses the original validated
output before spend reservation, including after a new frontier cycle begins.
Uncached work reserves rated spend atomically and writes a policy-bound result,
execution ledger row, token counts, pricing version, and actual rated cost.
`COMPANYOS_KNOWLEDGE_CYCLE_BUDGET_USD` defaults to `5` and
`COMPANYOS_KNOWLEDGE_DAILY_BUDGET_USD` defaults to `10`. Budget exhaustion
defers new paid calls but cannot delete evidence or invalidate a cache hit. The
maintained price catalog is versioned; another model is not eligible for
budgeted maintenance until its price is qualified.

Do not enable a scheduler merely because the endpoint deploys. First:

1. prepare and read-only qualify `companyos-postgres@1.6.0`;
2. pass the distinct-model smoke test;
3. pass all 13 live synthetic fixtures;
4. reconcile and extract one real authorized source object;
5. run one manually authorized compounding cycle and inspect aggregate receipt,
   proposal, and synthesis counts without printing payloads; and
6. verify retrying the same cycle reuses complete receipts and that a new cycle
   reuses unchanged task results without increasing rated spend.

Any runtime host may bind the same operation to its scheduler. The Vercel route
is a maintained adapter, not a Core dependency. Its schedule runs reconciliation
at minute `0` and extraction at minute `15` of every six-hour window. Expensive
maintenance advances nightly at `02:00` UTC. Initial and repair backfills use
repeated explicitly authorized bounded invocations until their durable cursors
complete; they do not permanently increase the model-maintenance frequency.
Leave the schedule disabled on
qualification failure, authorization denial, missing migration, or an
unexpected proposal/synthesis count.

## Granola runtime operation

The maintained Runner reads one SecretRef-only binding from
`COMPANYOS_GRANOLA_SOURCE_CONFIG_BASE64`. The decoded value contains the V2
requirement, binding identity, scopes, provider identity, lifecycle, fixed
CompanyOS access policy, and qualification receipt; it contains no credential
value. Runtime secret injection resolves `env:GRANOLA_API_KEY` only inside the
provider call. `CRON_SECRET` protects the qualification and reconciliation
routes, while `env:GRANOLA_WEBHOOK_SECRET` is a separate Standard Webhooks
signing secret and is required only for webhook delivery.

The portable runtime operations are:

- `POST /api/knowledge/sources/granola/qualification` performs a read-only
  provider check and returns bounded non-secret evidence;
- `GET` or `POST /api/knowledge/sources/granola/reconcile` claims a durable
  lease, resumes its cursor, reads at most two 30-note pages per invocation,
  applies a 24-hour overlap, stores complete note and transcript evidence, and
  advances the watermark only after a successful complete page;
- `GET` or `POST /api/knowledge/sources/granola/extract` processes at most two
  changed Source Objects per invocation, splits evidence above 50,000
  characters at line boundaries, restores validated chunk locators to
  source-global lines, and considers an object current only for the exact
  successful pipeline, prompt, model, and policy receipt; and
- `POST /api/knowledge/sources/granola/webhook` verifies the untouched request
  body and Standard Webhooks headers, persists the reference event before
  acknowledgement, and fetches content asynchronously.

The reference Vercel adapter schedules six-hour reconciliation and extraction
plus nightly resumable maintenance. Another runtime host may bind the
same operations to its scheduler, secret store, and
HTTP ingress without changing the Source, event, Raw Evidence, Raw Asset,
watermark, or lease contracts. A successful initial backfill MUST be followed
by aggregate checks for source status, processed/failed/quarantined counts,
current object count, Raw Asset count, and completed watermark. Those checks
must not print note or transcript content.

For rollback, verify that the previous bundle is still present and explicitly
activate its hash. Run `companyos knowledge rebuild --snapshot <hash>` to
reconstruct graph and optional embedding projections, then execute the
versioned retrieval regression ledger. Preserve review decisions, source
receipts/object versions, observation transitions/deletion requests/legal
holds, and activation evidence. Do not change `search_path` globally and do
not provision a second database for Company Knowledge.

An unavailable embedding adapter or `pgvector` index is not a total outage:
lexical retrieval remains active and returns explicit degradation evidence.
Restore and rollback are Instance operations and require live evidence beyond
repository tests. See the recovery and source-connection Guides for those
procedures.
