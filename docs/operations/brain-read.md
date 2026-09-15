---
document_id: operations.brain-read
title: Maintained Brain implementation
kind: operations
status: building
authority: canonical
language: en
updated: 2026-09-14
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
implementation_scope: provider
providers: [github, vercel, neon, postgres]
relations:
  implements: [specification.brain-read]
---

# Maintained Brain implementation

This is the experimental GitHub and Neon/Postgres implementation of the
[provider-neutral Brain contract](../specifications/brain-read.md). Its source
and local integration tests are available. Bounded private hosted reads and
synthesis have been qualified. Write, continuation and freshness qualification
must identify their own exact candidate and isolated environment before live
adoption; read evidence alone does not qualify later behavior.

## Bind the existing installation

Declare connector `oregano/brain@0.1.0` in the existing tracked Instance
configuration, and bind only granted capabilities to it. Its configuration accepts
`repository_binding_id`, `repository_id`, `branch` and optional `freshness`.
For example:

```yaml
configuration:
  repository_binding_id: workspace-repository
  repository_id: example-company/workspace
  branch: main
```

This names an already verified GitHub App installation in the existing
repository installation store. If Builder is present, the repository and source
binding must match its existing Workspace binding. The runtime verifies the
Instance and service environment and uses short-lived installation tokens
limited to `contents: read` for that repository. Credentials never enter Tool
inputs, model calls or Workspace files. No Builder coding worker is launched.
The HTTP adapter verifies the branch ref, immutable commit/tree, ordinary file
modes and blob content hash/size. A truncated inventory fails closed. Only
`brain/` blob content is fetched.

Initial scans are bounded at 1,000 files, 400,000 bytes per file, 32 MB aggregate
source bytes and 5 MB per provider response. Requests have a 20-second timeout,
an entire repository read has a 180-second deadline, and blobs are fetched five
at a time. The initial implementation scans and validates the complete corpus;
it does not claim unbounded backfill throughput.

Writes acquire a short-lived `contents: write` token for the same repository,
without pull-request or administration permission. One GitHub GraphQL
`createCommitOnBranch` uses `expectedHeadOid`, bounded files and content-free
operation/input trailers. The adapter validates commit identity and parent.
Moved heads conflict; repository-required review returns
`repository_review_required`. It never forces a branch or invokes a release.
Read-only reconciliation searches at most 100 commits and verifies the exact
parent, changed-file count and before/after content. Absence in that bounded
window is not proof that no commit happened. After the bounded Workflow wait,
inspect the operation trailers and repository history manually; missing proof
keeps the operation blocked, and a new operation key cannot resolve uncertainty.
An unavailable changed-file count also fails closed until proof is available.
See GitHub's [commit contract](https://docs.github.com/en/graphql/reference/commits).

## Prepare and qualify the existing database

The additive manifest `companyos-postgres@3.1.0` adds only the derived
`companyos_brain` schema: revisions, pages, Takes, links and change metadata.
Existing control, Records, historical manifests and audit data remain intact.
Use the existing authorized `companyos database prepare`, then
`companyos database verify`, in the intended secret-bound environment. Health
and qualification stay read-only. Qualification receipt version 2 now identifies
manifest 3.1.0 and includes the five Brain tables; an old receipt is insufficient.
There is no implicit migration on a Brain read or sync.

The store uses the maintained Neon HTTP driver against the Instance's existing
`DATABASE_URL`. A transaction stages the snapshot once, applies an expected-base
and lease guard, then updates all derived tables and the checkpoint together.
The serialized transaction is capped at 3.5 MB; an oversized batch leaves the
checkpoint unchanged. This transport bound may be reached before the repository
file bound. Broader ingestion requires a separately tested batching extension.
Search uses PostgreSQL text search with English, German, Spanish and French
stemming and simple tokenization for other languages. No vector service is needed.
Local database evidence uses the repository's loopback HTTP bridge; it does not
qualify an arbitrary Postgres URL or an untested live host.

## Check, sync and inspect

```sh
companyos brain check /path/to/workspace --format json
companyos build /path/to/workspace --output /private/operator/artifact.json
companyos database verify --format json
companyos brain sync --artifact /private/operator/artifact.json --format json
companyos brain entity --artifact /private/operator/artifact.json --agent assistant --subject-principal company:member --input /private/operator/entity.json
```

The entity input is `{"name":"people/alex"}`. Other read commands are `recall`,
`context_pack`, `synthesize` and `delta`, with the same inputs as their Agent Tools.
`remember` and `forget` use the same administrator CLI and actual Agent runtime,
requiring their separate effective write grants. Repeat identical operation keys
to reconcile existing receipts; the CLI exits with code 2 for saved/pending sync.
Checking is local and needs no database or model. Sync reads current Git through
the configured App, validates all pages and reports diagnostics. It does not
publish Git commits or trigger deployment. Unsupported or missing declaration
policy fails during Workspace validation and Artifact compilation.

Operator Tools require a trusted Artifact produced by `companyos build`, its
exact Core checkout, an explicitly selected Agent and an existing active roster
principal. They execute through the normal runtime and retain its evidence.
The local CLI is a privileged administrator interface with database credentials;
`--subject-principal` is an explicit on-behalf-of choice, not an authentication
protocol for remote users. Ordinary hosted requests retain their existing
provider authentication. Never expose this CLI as an unauthenticated endpoint.

The write Tool deadline is 120 seconds. A timeout does not prove no Git effect:
the next call must reconcile the existing operation. The repository lease lasts
300 seconds and a provider commit call is bounded to 30 seconds.

The host connector reuses the existing model recipe resolution and language
executor for `brain.synthesize`. It permits one composition call, at most 4,000
output tokens, a 55-second model deadline and the existing 65-second language
Tool deadline. Missing configuration is explicit. A read never resolves Git
credentials; it uses only the scoped successful projection.

## Verification and recovery

Synthetic tests cover file boundaries, parsing and evidence paths, active-Take
retrieval, revision consistency, common grants and actual Agent runtime calls,
GitHub installation isolation, content verification and synthesis failure modes.
Required local PostgreSQL tests cover migration, full-text retrieval, removal,
atomic checkpoint publication and preservation of control/Records data.

For an invalid corpus, repair the source in Git and retry sync. For a concurrent
sync, retry against the latest head after the current lease finishes. Keep the
previous successful projection until a replacement is valid. Rebuild only the
derived Brain scope; preserve shared control state, operation receipts and Take
identity high watermarks. A saved write with unavailable indexing resumes only
sync. An uncertain write uses provider receipt reconciliation, never an automatic
resend. Automatic source ingestion and completed live adoption remain pending.

## Explicit freshness activation

The optional Instance binding enables the maintained consumer:

```yaml
freshness:
  push_events: true
  reconcile_interval_seconds: 900
```

The interval is explicitly chosen per Instance, from 300 to 86,400 seconds.
Omission disables background freshness. The existing GitHub webhook endpoint
verifies the HMAC signature, delivery identity, active installation, repository
numeric ID and exact branch before scheduling a Brain timer. Delivery replay
is idempotent. No changed-path list or old event SHA selects index contents;
sync reads the current bound head. Configure the existing App's push subscription
and webhook URL explicitly; code availability does not create that subscription.

`/api/brain/reconcile` uses the existing `CRON_SECRET` and production-deployment
guard. The maintained host wakes every five minutes; reviewed Instance intervals
control periodic reconciliation. One invocation claims at most 25 existing
`brain-sync` timers and coalesces them into one sync. Retries preserve timer
identity, back off to at most an hour and retain content-free failure status.
Obsolete bindings cannot select another repository. This uses the existing
durable timer and Records lease stores, with no new queue or session service.

Before activation, qualify writes in an isolated branch with unchanged
deployment identity, source read-back, delta continuation, duplicate operations,
conflicting edits, and Git-success/index-failure recovery. Recheck actual Git and
hosting triggers; source-level absence of release calls alone does not prove
the external host's deployment behavior.

The maintained write Tool preserves a typed `write_conflict` or `invalid_batch`
diagnostic through the isolated worker. Reread changed pages before submitting a
new operation; do not blindly retry stale replacements. These validation failures
are distinct from an unknown provider outcome and do not prove a new commit.
