---
document_id: specification.company-records-query-v1
title: Company Records Workflow Query Contract
kind: specification
status: approved
authority: canonical
language: en
updated: 2026-09-05
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
The workflow reference's source and parser work must establish that proof
before hosted acceptance.

## Evidence

`record-query.test.ts` covers filters, authorization, completeness versus
freshness, empty and failed scans, stable JSON identity, paging and bounds.
`record-query-postgres.test.ts` runs in the mandatory database gate and
exercises the real SQL read, JSONB, restart, source isolation and failed scans.
These are Records contract tests; they do not prove workflow execution or
actual provider synchronization.

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
