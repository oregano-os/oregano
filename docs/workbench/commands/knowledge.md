---
document_id: command.knowledge
title: companyos knowledge
kind: command
status: building
authority: canonical
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - specification.company-knowledge-v0.1
    - specification.company-knowledge-v0.2
---

# `companyos knowledge`

The command group validates, builds, previews review work, and operates the
maintained Knowledge Provider.

```bash
companyos knowledge inspect /path/to/workspace --format json
companyos knowledge build /path/to/workspace --output /secure/path/knowledge.json
companyos knowledge review /path/to/workspace --format json
companyos knowledge review /path/to/workspace --persist
companyos knowledge decide /path/to/workspace --candidate <id> --decision accepted|rejected|superseded --principal <principal>
companyos knowledge propose /path/to/workspace --candidate <id> --output /secure/path/proposal.json --principal <principal>
companyos knowledge stage --bundle /secure/path/knowledge.json
companyos knowledge verify --snapshot <bundle-hash>
companyos knowledge activate --snapshot <bundle-hash>
companyos knowledge rebuild --snapshot <bundle-hash>
companyos knowledge regression /path/to/workspace --ledger retrieval-regression.yaml
companyos knowledge source verify --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml
companyos knowledge source sync --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml --workspace .
companyos knowledge source ingest --requirement connections/local-source.md --binding /secure/instance/local-source.yaml --input /exact/file.md --object stable-object-id --media-type text/markdown
companyos knowledge source health --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml
companyos knowledge source revoke --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml
companyos knowledge source delete-request --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml --workspace . --principal human:knowledge-steward --object docs/example.md --reason "Approved deletion"
companyos knowledge source delete-restore --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml --workspace . --principal human:knowledge-steward --request <request-id>
companyos knowledge source legal-hold --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml --workspace . --principal human:knowledge-steward --request <request-id> --enabled true
companyos knowledge source delete-apply --requirement connections/knowledge-source.md --binding /secure/instance/knowledge-source.yaml --workspace . --principal human:knowledge-steward --request <request-id>
companyos knowledge session transfer --input /exact/stop-buffer.json
companyos knowledge session cleanup --now 2026-08-26T12:00:00Z
companyos knowledge session archive --corpus <corpus-id> --requirement connections/local-archive-source.md --binding /secure/instance/local-archive-source.yaml
companyos knowledge observation record --input /secure/path/observation.yaml
companyos knowledge observation review --persist
companyos knowledge observation expire --now 2026-08-25T12:00:00Z
companyos knowledge observation delete-request --observation <id> --principal <principal> --reason <text>
companyos knowledge observation legal-hold --observation <id> --principal <principal> --enabled true
companyos knowledge observation delete-apply --observation <id>
```

`inspect` and review preview are read-only. Review emits at most three
candidates; `--persist` inserts new digest-bound candidates into the Instance
review queue. Persisted candidate hydration, `decide`, and `propose` require an
active non-Agent roster principal in the reserved
`companyos:knowledge-admin` group. `decide` records one attributable terminal
human decision but does not write, merge,
publish, or activate a Workspace change. `build` requires a clean Workspace,
writes a new immutable bundle, and refuses
to overwrite its target. `stage`, `verify`, and `activate` use the existing
`DATABASE_URL`; they create or use `companyos_knowledge`, never a second
database. Activation is an explicit operator action and requires a verified
snapshot.

Knowledge Bundle `3` carries normalized document/fragment policies. Provider
and standard Tool contract `3.0.0` require a trusted runtime subject. Search
filters lexical and vector candidates before ranking; exact get, graph
traversal, citations, review hydration, and model Tool output reuse the same
policy intersection. Missing or inactive identity, unknown policy, and mapping
failure return no protected content. Access-decision evidence contains hashes
and policy metadata, never queries or content payload.

`rebuild` reconstructs graph and optional vector projections from a named
immutable bundle and writes index-run evidence. `regression` runs a version-1
query ledger locally and fails when any expected authorized OKF path is
missing. A positive ledger declares an active `subject` with stable group IDs;
an omitted subject is an intentional negative access case. Hybrid
search uses the local no-egress adapter by default; an unavailable optional
vector index degrades explicitly to lexical retrieval.

`propose` works only for an accepted, unchanged raw source. It writes a
digest-bound JSON description of create/index/archive operations. It does not
apply those operations; they enter the normal governed Workspace diff.

Source commands keep the Workspace requirement separate from the non-secret
Instance binding. The binding contains an `env:NAME` SecretRef, never a token.
All generic source operations resolve the exact maintained implementation
through the Core Source Connector registry. Resolution checks the Connector
and contract versions, Source kind, delivery mode, binding lifecycle, and
qualified implementation digest before a provider call and emits a bounded
non-secret receipt. A native V2 binding must be qualified and `active` before
`sync`; installation or binding alone does not activate ingestion. The
experimental repository V1 shape remains an explicit compatibility
registration whose maintained implementation already runs through the V2
pipeline. It remains quarantine-only and preserves its existing Connector and
Source identities. New GitHub bindings use native Connector `2.0.0`.
`verify` and `health` are read-only provider checks. `sync` is an explicit
database mutation: it persists events before fetch, records immutable Raw
Evidence and receipts, applies ACL and sanity gates, and reconciles absence only
from a complete fresh inventory. For a hybrid Connector, the same command uses
change reconciliation with its bounded overlap and completed watermark rather
than repository enumeration. It does not require an active Handbook
snapshot and does not create review candidates directly; extraction and review
are later pipeline stages. `revoke` disables the local binding without making a
provider write. Provider deletion never purges content. Payload removal
requires `delete-request`, an authorized Knowledge administrator, a dependency
preview, the 72-hour restoration window, and `delete-apply`. `legal-hold`
blocks application and `delete-restore` cancels the pending deletion. The old
deadline-wide `source purge` operation is not part of the V2 path.

The maintained Granola Connector accepts signed `note.generated`,
`note.edited`, and `note.access_granted` reference events and uses the provider
API only after durable enqueue. Its public API does not expose sufficient
per-note principal ACL evidence, so the Connector supports a fixed CompanyOS
root policy or quarantine, never an inferred provider-ACL mapping. Oversized
transcripts remain fail-closed until a durable Raw Asset adapter is qualified;
the maintained Postgres runtime provides an inline binary adapter in the
existing Company Instance database.

`source ingest` accepts exactly one regular UTF-8 file and a stable object ID.
It never expands a glob, walks a directory, or treats a local path as
authorization. The content traverses the same Source Event, ACL, sanity, Raw
Evidence, receipt, and change-stream boundary as a provider object.

`session transfer` writes a bounded Agent stop buffer idempotently into the
temporary Session Corpus before removing that exact buffer file. `session
cleanup` redacts expired temporary Corpus payloads after 30 days and preserves
their non-content lifecycle evidence. An orphan stop-buffer adapter may remove
abandoned buffers after seven days. Neither operation deletes retained Raw
Evidence, Pages, Claims, syntheses, or Handbook content. `session archive` is a
separate explicit action and requires a local Source with `retention: retain`;
the resulting durable Raw Evidence survives Session Corpus cleanup.

Runtime Observation commands record temporary business evidence, queue only
active observations for the same human review path, expire timed observations,
and enforce deletion-request and legal-hold transitions. None of these commands
publishes active OKF. Accepted source or observation candidates use `propose`
to create the same digest-bound, unapplied Workspace proposal.

The ordinary `companyos build` command also writes a sibling
`*.knowledge.json` bundle (or the path supplied with `--knowledge-output`) and
records its manifest in the control Artifact.
