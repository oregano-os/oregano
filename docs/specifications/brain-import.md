---
document_id: specification.brain-import
title: Bounded Brain import policy and evidence
kind: specification
status: draft
authority: canonical
language: en
updated: 2026-09-14
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Bounded Brain import policy and evidence

The internal policy and accounting foundation is implemented; the owning
Workflow, source delivery, live cost qualification and production activation
remain separate unfinished increments. These helpers do not add a public Tool,
provider permission, schedule or Company Agent. They are not an alternate source
import endpoint. The existing Workflow, Records, scoped generation and Brain
operations must compose them before an import is deployable.

A Workspace keeps literal selection policy in its ordinary workflow config:

```yaml
schema_version: 2
id: brain-import
transcripts:
  mode: bounded
  max_transcripts: 4
  meeting_date:
    start_at: null
    end_at: null
```

This quantity is illustrative company policy, not a Core default. The validator
accepts positive cumulative limits up to the technical bound of 10,000 identities.
Start is inclusive, end exclusive. Explicit RFC3339 instants require their timezone
offset; activation normalizes them to UTC. A null start adds no lower date filter
inside actual provider coverage. A null end freezes once at setup time; a future
end is rejected. Invalid dates and an inverted interval fail validation.

`freezeTranscriptCohort` uses an existing StateStore effect checkpoint keyed by
stable Company Instance/import identity. Setup is called only after ordinary
operator authorization with qualified inventory and reviewed Workspace policy.
It reserves all previously used local transcripts before selecting newest eligible
finished provider transcripts, ordered by stable identity for timestamp ties.
Duplicate resource identities count once; conflicting versions/provenance fail.
Unresolved dates are excluded visibly, while already admitted local evidence is
retained and shown when outside the configured range. A claimed equality between
local and provider identities requires upstream provenance; this helper never
merges identities by title, guessed participant or similar text.

Selection freezes one immutable cohort per normalized policy digest. A retry,
timer, other delegated user or deployment reuses it and cannot refill failures,
skips or a short inventory. New local evidence cannot be slipped into an existing
cohort. Complete inventory is required before first selection. A requested lower
bound earlier than available provider history fails visibly; a date edit cannot
create an unavailable historical source. Discovery is bounded to 20,000 candidates.

An ordinary validated Workspace configuration activation may create an extension
with a new run identity. Raising an allocated limit from four to six admits at
most two new identities. Moving the start backward alone never raises the ceiling.
A lower limit than cumulative admissions fails; the original in-flight run can
still resume its frozen policy. Existing cohorts, initial source versions and
knowledge remain intact. Concurrent setup uses atomic compare-and-set; bounded
contention fails with a retry diagnostic rather than losing admissions. Retained
cohort history is bounded to 1,000 activations.

The manifest identifies newly admitted sources. Ordinary Records version outcomes
and durable Workflow steps still decide processing: an unchanged completed source
must not call models again because dates or quantity changed. A changed source
version requires explicit reconciliation under its retained identity. All source
slots, including skipped, failed and unavailable items, stay allocated. An import
report joins those version outcomes to the exact run/step/attempt records described
in [model recipes](model-recipes.md#scoped-generation-attempt-evidence), preserving
the first cohort report and separate extension/cumulative totals.

No real source, company name, account list, provider credential, fixed pilot size
or company-specific value threshold belongs in these Core mechanisms. The owning
Workspace adopts Skills, filing vocabulary, common triage calibration and model
phase bindings. Instance state retains manifests, source-operation bindings,
secrets and receipts. Source adapters only return evidence through Company Records.

## Meet discovery checkpoint

The generic `packages/connectors/google-meet/` transport uses Google's maintained
authentication SDK with one explicitly bound service-account identity and delegated
subject. It validates the key identity before constructing the SDK client, fixes
the read-only Meet scope and API host, and never uses ambient credentials or
provider URLs from source content. Tokens and private keys remain in the Instance.
Source text, provider error bodies and credentials never appear in errors or
content-free discovery receipts.

Metadata discovery lists all available ConferenceRecord and Transcript pages for
one explicit subject, retains stable Transcript identities and excludes ongoing
conferences and unfinished transcripts. It does not fetch entries, Docs, Drive or
a user directory, select a cohort, or start model processing. This allows the
initial source identities to be reviewed and frozen before paid sample calls.
Its completeness statement applies only to that subject's available provider
inventory; it is not historical or company-wide coverage. The provider removes
ConferenceRecords 30 days after conference end.

The transport also supports parent-scoped entry and participant lists. Entries
retain their exact text, timestamps and speaker resource references. Pagination
fails on exhausted bounds, repeated tokens, malformed lists, foreign resource
names or conflicting duplicates. Permission errors cannot become empty inventories.
429/5xx retries are limited to three attempts; a longer Retry-After is returned as
a retryable diagnostic instead of blocking a worker. Response size and per-request
time bounds are explicit. Metadata discovery and entry transport are a foundation;
the actual provider rehearsal and complete ingest Workflow are not yet complete.

`oregano/google-meet-record-source@0.1.0` is registered with the existing CLI
and hosted Records registries. Its non-secret binding holds one explicit delegated
identity and an exact list of Transcript resource names. A content-free qualification
receipt binds those names to complete metadata discovery. Changed subjects or
selections require new qualification; installation alone grants no access. Runtime
credential resolution still uses the existing Instance SecretRef.

The adapter rechecks each selected generated transcript, retains all entry and
participant data, and fails the whole inventory on missing access, empty completed
transcripts, partial pagination or a transcript that changes during reading.
Records receive the provider-neutral source identity/version, complete readable
text, original reference and preserved provider payload. A separate `source_context`
JSON field carries complete conference, transcript and participant metadata without
duplicating entries. Workspace projections must retain this evidence when the
procedure needs attendees, including people who have no transcript entry. Provider
user IDs and display names remain untrusted source evidence, never inferred email,
roster membership or an authority grant. Content versioning excludes
the reader, fetch time and selection scope; participant ordering does not create
spurious versions. Entries are sorted with nanosecond precision. Completeness
means the exact selected transcripts were read, never all company meetings. The
ordinary source connection/rehearsal lifecycle supplies synchronization and
projection evidence; no Brain-specific provider endpoint or source database is
introduced. Historical expiry is an error to reconcile, not an instruction to
delete source-derived Brain knowledge.

Primary provider contracts: [conference lists](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list),
[transcript entries](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list),
[conference retention](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords),
and [Google authentication SDK](https://github.com/googleapis/google-auth-library-nodejs).
