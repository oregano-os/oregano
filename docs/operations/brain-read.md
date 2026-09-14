---
document_id: operations.brain-read
title: Maintained Brain read implementation
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

# Maintained Brain read implementation

This is the experimental GitHub and Neon/Postgres implementation of the
[provider-neutral Brain contract](../specifications/brain-read.md). Its source
and local integration tests are available; live company retrieval, synthesis
quality and deployment qualification are still pending. Do not activate an
unqualified candidate based only on these tests.

## Bind the existing installation

Declare connector `oregano/brain@0.1.0` in the existing tracked Instance
configuration, and bind only the granted read capabilities to it. Its
configuration accepts only `repository_binding_id`, `repository_id` and `branch`.
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
`context_pack` and `synthesize`, with the same inputs as their Agent Tools.
Checking is local and needs no database or model. Sync reads current Git through
the configured App, validates all pages and reports diagnostics. It does not
publish Git commits or trigger deployment. Unsupported or missing declaration
policy fails during Workspace validation and Artifact compilation.

Operator reads require a trusted Artifact produced by `companyos build`, its
exact Core checkout, an explicitly selected Agent and an existing active roster
principal. They execute through the normal runtime and retain its evidence.
The local CLI is a privileged administrator interface with database credentials;
`--subject-principal` is an explicit on-behalf-of choice, not an authentication
protocol for remote users. Ordinary hosted requests retain their existing
provider authentication. Never expose this CLI as an unauthenticated endpoint.

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
derived Brain scope; do not delete the shared Instance database. No write Tool,
provider ingestion, automatic sync trigger or live semantic acceptance is claimed
by this increment.
