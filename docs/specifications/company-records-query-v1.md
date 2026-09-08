---
document_id: specification.company-records-query-v1
title: Company Records Workflow Query Contract
kind: specification
status: approved
authority: canonical
language: en
updated: 2026-09-06
owners: [oregano-maintainers]
audience: [human, agent]
---

# Company Records Workflow Query Contract

The `records.query` Capability and `oregano:records/query` standard Tool use
the same input and output schemas, contract version `2.0.0`. The result adds
typed rows, `snapshot_id`, `source_proofs` and optional `synced_through`.
Consumers of the old strict output schema must adopt the new contract with
the workflow-engine release. Provider credentials and SQL remain unavailable
to Agents and Company Tools.

The migration updates the Instance binding for `records.query` to
`contract_version: 2.0.0` and rebuilds its Artifact with the matching Core.
Other Capability versions remain unchanged. Old immutable Artifacts retain
their original contract and execution source; they are not rewritten. A
binding still pinned to `1.0.0` is rejected when compiling a new Artifact.

## Projection declaration

Optional `source_ids` selects exact declared source identities before
projection. `selection` continues to compare normalized record values; a
field named `source_id` inside `selection` is not source metadata. With no
explicit source list, all declared sources of that record type contribute.

Optional `filters` maps Workspace-defined parameter names to generic
operators and exposed field paths:

```yaml
filters:
  status_in: { operator: in, path: status }
  changed_since: { operator: after, path: changed_at }
  work_item_ids: { operator: in, path: item_id }
  missing_any_of:
    operator: missing-any
    path: fields
    fields: [summary, estimate]
```

`equals` compares canonical JSON values. `in` requires an array and compares
one field with its members; an empty array matches no rows. `after` compares
ISO instants inclusively, avoiding omissions at a repeated synchronization
boundary. `missing-any` requires a nonempty subset of its declared field
allowlist, relative to `path`. Missing, null, blank strings and empty arrays
are absent; zero and false are present. Operators can be combined, and all
must match. Unknown parameters fail. Without a `filters` declaration, equality
filters on exposed top-level fields remain available.

## Immutable reads and bounds

Authorization and its audit decision precede data and source-proof reads.
The store reads rows and completion receipts together. Postgres uses one SQL
statement and one MVCC snapshot; the memory store copies both without yielding.
All filtering and paging operate on that immutable read. This provides a
consistent local projection snapshot, not a provider transaction across all
remote objects.

`limit` is a page size from 1 to 200. `all_pages: true` drains the complete
authorized result from its first page. It cannot be combined with a starting
cursor. Repeated cursors, duplicate row identities and a continuing empty page
fail. Page cursors bind to the snapshot and query; if data, filters, projection
or source proof changes, the caller restarts the query.

The initial implementation bounds the full projection snapshot to 10,000 rows
before query filtering. Overflow is an explicit error, including for a
single-page query; it is never silent truncation. Narrow the declared
projection or its source scope for larger collections. The bound keeps the
immutable snapshot bounded without keeping a database transaction alive
across hosted requests. Future storage pushdown must preserve these semantics.

## Synchronization evidence

A qualified Record Source inventory may supply `synced_through`, the instant
through which it proves complete coverage of its declared resource scope.
The synchronization service stores that value only after every object and
projection operation succeeds, with a digest of the exact source declaration.
When a source opts into roster identity resolution, this digest also binds the
frozen reviewed identity directory; earlier receipts cannot establish coverage
after its mapping changes. See the
[normalization contract](company-record-normalization-v1.md).
It must not exceed inventory observation time. A cursor, recent row, scan
completion time or legacy receipt does not create this claim implicitly.

The query returns each contributing source's exact receipt, watermark,
declaration digest and completeness instant. Overall `synced_through` exists
only when every contributing source has matching evidence; its value is the
earliest of those instants. `require_synced_through` fails with an actionable
diagnostic if the evidence is missing or too old. Empty synchronized sources
are valid; unsynchronized empty results cannot prove completeness. Changing
the source declaration or its identity directory requires new synchronization
evidence. Hosted source selection honors explicit projection `source_ids`;
legacy value-level `selection.source_id` remains a value predicate.

This contract does not yet qualify a provider's time coverage. Maintained
provider adapters that do not supply explicit `synced_through` continue to
work for ordinary queries, but cannot satisfy a completeness requirement.
A workflow requiring historical coverage must establish that proof before
hosted acceptance. Workflows accepting current observations may instead use
the explicit current-scan requirement below.

## Evidence

`record-query.test.ts` covers filters, authorization, completeness versus
freshness, empty and failed scans, stable JSON identity, paging and bounds.
`record-query-postgres.test.ts` runs in the mandatory database gate and
exercises the real SQL read, JSONB, restart, source isolation and failed scans.
These are Records contract tests; they do not prove workflow execution or
actual provider synchronization.

## Exact Instance binding evidence

Hosted source selection validates and freezes every contributing Instance
binding and qualification receipt. Its source digest includes their canonical
digest, including provider account/resource configuration, Connector version,
SecretRef and qualification content. No credential value enters this digest.
CLI synchronization binds the selected source in the same way. A bound
inventory must carry the matching `binding_digest` supplied by its Connector;
a missing or changed digest fails before database writes. Duplicate object
identities also fail before synchronization begins.

Maintained Slack `0.1.4` and Monday `0.3.3` source Connectors reread the actual
credential identity and selected resource metadata before inventory data.
Slack requires the reviewed team, bot user, conversation kind/membership and
history/read scopes. Monday requires the reviewed account, member identity,
member kind and administrator-confirmed external-Agent mapping; selected groups
and column mappings must still be available. Display names do not authorize
the mapping. A replaced SecretRef value cannot silently relabel another
account's observations. Completed synchronization retains the content-free
inventory/identity receipt as `provider_evidence` in its durable sync receipt.
This identity check supplies no implicit `synced_through` value.

Bound normalized versions include `source_digest` in their immutable identity
and receipt. Identical provider values from a different binding therefore
cannot reuse an old version. Queries read content-free version provenance in
the same memory/SQL snapshot as rows and receipts and reject any retained row
without the exact contributing source evidence, before applying filters.
An empty or partial resynchronization cannot legitimize old rows by adding a
new receipt. Receipt selection compares exact source digests before choosing
the latest completeness instant.

`record-binding-evidence.test.ts` and the mandatory Postgres query suite prove
these boundaries. Provider time coverage remains a separate requirement.

## Retained source and projection generations

A bound source's physical storage identity is a versioned hash of its logical
ID and complete source digest. Its events, immutable versions, current pointers,
leases, watermarks and receipts therefore remain independent when bindings or
identity mappings change. A projection's storage identity hashes its complete
definition. Rows also include their source generation in the storage key, and
immutable reads select the exact contributing source generations before the
row bound and paging. Logical Workspace source/projection IDs remain the public
service contract. Instance identity stays unchanged in every table.

This reuses existing tables and atomic store operations without a new SQL
schema or copying historical evidence. New generations start unqualified and
empty; they never fall back to legacy rows or another Artifact's data. CLI,
hosted reads, synchronization, reconciliation and status/receipt lookup resolve
the same storage identities. A bound registry freezes when storage is first
used so its namespace cannot change during an operation.

Successful synchronization records the exact projection definitions it
materialized. A source receipt alone cannot establish that a newly declared
projection is completely empty. That projection requires its own successful
materialization, including when all source observations are duplicates. Earlier
projection definitions retain their own rows and matching receipts; lease
release and reconciliation in one source generation cannot alter another.

Historical Artifacts select their retained definitions and evidence after a
restart. Keep synchronizing every generation needed by active runs through its
required cutoff; retaining a generation does not manufacture new provider
observations. Source configuration remains in the immutable Artifact, credentials
remain Instance SecretRefs, and provider cutoff qualification is still required.

## Exact timestamp comparisons

Timestamp filters, source completeness gates and latest-proof selection accept
valid ISO calendar instants with timezone and up to nine fractional digits.
Comparison preserves all supplied digits, including across timezone offsets;
invalid calendar dates and excess precision fail rather than being normalized
or rounded. The `after` operator remains inclusive. Proof output is canonical
UTC with at least three and at most nine fractional digits.

Memory and Postgres choose the same latest completeness receipt even within
one microsecond. Postgres orders the integral second and original fractional
text separately, retaining the proof in JSONB. This correction does not give
a provider an unqualified completeness watermark.

## Complete current provider scans

The unreleased workflow-engine query contract also accepts
`require_scan_started_after`. This is an explicit alternative to
`require_synced_through`; combining them fails. It requests the current contents
seen during complete provider scans starting at or after the specified instant,
not historical reconstruction at that instant. The comparison is inclusive and
preserves nanosecond precision. Workspace policy defines the deadline and the
eligibility of individual observations.

Maintained Slack and Monday sources report `scan_started_at` before identity
qualification and data reads and `observed_at` after all required pages return.
These timestamps describe an observation interval, not a transactional snapshot
of the remote provider. Existing scope, identity, pagination, rate-limit and
permission checks still apply. Slack only discovers roots inside the binding's
reviewed history window; a caller must qualify coverage of its actual thread.
A scan timestamp does not broaden that scope or create `synced_through`.

After successful normalization and projection materialization, synchronization
retains exact immutable `scan_version_ids` in the existing receipt summary.
Membership contains version identifiers, not duplicate message payloads. Current
scan queries select the latest eligible successful receipt for every exact
source and projection generation and its immutable versions together. Postgres
uses one SQL/MVCC statement; the memory store copies without yielding. The
service applies the reviewed projection to those versions, never to a mixture
of old current rows and a later partially ingested scan. Failed scans do not
publish membership. Existing versions and audit receipts remain retained.

An object absent from the selected complete scan contributes no result, even
when an older projection row remains. This is scoped inventory absence, not an
inferred global provider deletion. Visible edits contribute their observed
contents. Successful empty scans are valid; missing or incomplete membership,
wrong declarations, wrong Instance/source provenance, stale starts, invalid
intervals and failed scans do not establish readiness. The query bounds total
contributing inventory membership to 10,000 versions before projection and
filtering. Larger inventories remain synchronizable for ordinary reads but do not retain
current-query membership. A current query fails with a source-narrowing
diagnostic instead of using an older smaller scan.

Results include `scan_started_at` (the earliest contributing scan start) and
`source_scan_proofs`: exact source/digest, sync run, start/completion interval,
watermark and membership digest. They retain `source_proofs: []` and omit
`synced_through`. Snapshot/cursor identity includes the selected scan proofs;
retrying the same completed observation is stable. Authorization precedes
inventory reads. Ordinary and historical query behavior remains unchanged.

`record-current-scan.test.ts` and the mandatory Postgres query suite cover edits,
absence, empty scans, failed completion, concurrent ingestion, exact timestamps,
source generations, immutable membership, restart, authorization and paging.
Workflow authoring, the compiler, trusted input guard and hosted retained-run
verification support the explicit current-scan requirement; see the
[workflow contract](workflow-execution-v1-draft.md). Operating Workspace adoption
and actual provider acceptance remain separate delivery work.
