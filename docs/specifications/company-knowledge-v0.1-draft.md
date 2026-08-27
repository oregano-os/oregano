---
document_id: specification.company-knowledge-v0.1
title: Company Knowledge v0.1 Specification
kind: specification
status: implemented
authority: normative
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - specification.tool-architecture
    - architecture.boundaries
---

# Company Knowledge v0.1 Specification

## 1. Scope and authority

Company Knowledge is the shared, reviewed evidence surface for one Company
Workspace. In V1, curated authority exists only in Open Knowledge Format (OKF)
files under `handbook/`. Database rows, search indexes, fragments, model
summaries, raw notes, and review proposals are projections or evidence and MUST
NOT override the exact Workspace commit.

V1 uses the existing Company Instance Postgres database. Control state remains
in `companyos`; knowledge projection and review state use the explicitly
qualified `companyos_knowledge` schema. An implementation MUST NOT require a
second database URL.

## 2. OKF v0.1

Each curated concept is one UTF-8 Markdown file below `handbook/` with YAML
frontmatter:

```yaml
---
type: concept
description: A short, searchable description of the concept.
visibility: company
---
```

`type` MUST be `concept`, `playbook`, or `note`; `description` MUST be a
non-empty string; and the Markdown body MUST be non-empty. Optional `status`
is `current` (default), `stale`, or `contested`; optional `valid_until` is an
ISO date or timestamp. `visibility` is `public`, `company` (default), `team`,
`restricted_group`, `individual`, or `private`. Restricted documents declare
stable `allowed_groups` or `allowed_principals`; optional
`denied_groups`/`denied_principals` override matching allows. A declared
`personal_data: true` or non-`business` `data_class` requires `team` or
narrower visibility and an explicit allowed subject. The relative path is
the stable concept identity. `handbook/index.md` is required and MUST reference
every OKF document. `handbook/index.md` and the authorization roster at
`handbook/roster.md` are operational Handbook files and are not projected as
searchable OKF in V1.

Links between OKF documents MUST be ordinary relative Markdown links. Absolute,
escaping, or unresolved local links fail validation. Wikilinks, transclusion,
and executable content are outside v0.1.

## 3. Raw and curated lifecycle

`brain/inbox/` contains raw, untrusted review input. It is never bundled or
searched. Each raw Markdown file declares non-empty `source` and `actor`, an
ISO `captured_at` value, and boolean `personal_data` in YAML frontmatter.
Personal raw input remains in administrator-only quarantine until a restrictive
policy and review decision exist. `brain/archive/` records reviewed outcomes.
Raw input passes encoding, size, empty-content, low-diversity junk, and
credential-indicator checks before triage. Triage compares
the input with active OKF, assigns an `okf`, `playbook`, or `learning` route,
and returns no more than three candidates per cycle.

A candidate begins as `pending` or `quarantined`. Only an attributable human
may record `accepted`, `rejected`, or `superseded`. Acceptance is not
publication: it produces a proposed Workspace change that still follows normal
review, merge, build, verification, and activation. A decision identifier is
bound to the source path and digest so unchanged rejected or superseded input
can be suppressed.

## 4. Deterministic Knowledge Bundle

The Builder normalizes line endings and trailing newlines, orders documents by
path, validates links and index reachability, and creates heading-aware bounded
fragments. Every document and fragment has a content digest. Every fragment
records its path, heading, start and end line, and digest.

The immutable bundle contains:

- schema version `3` and OKF version `0.1`;
- exact Workspace commit and policy hash;
- normalized, versioned access policies and one policy identity on every
  document and fragment;
- ordered normalized documents and fragments;
- deterministic directed link edges, orphan identities, and a graph hash;
- document and fragment counts; and
- a SHA-256 bundle hash over every preceding field.

The control Artifact contains only the bundle manifest and hash. The Knowledge
Bundle remains a separate deployable artifact so full Handbook content is not
duplicated into every Agent prompt. An Agent with a Knowledge Tool grant MUST
retrieve OKF through the logical knowledge surface.

## 5. Snapshot lifecycle and provider contract

A Knowledge Provider implements `stage`, `verify`, `activate`,
`activeSnapshot`, `search`, `get`, `traverse`, and `health`. Staging is idempotent by bundle hash.
Verification checks stored document and fragment counts before setting a
verification receipt. Activation MUST fail for an unverified snapshot and MUST
leave exactly one active snapshot. Activating a prior verified snapshot is the
V1 rollback mechanism.

The maintained Connector ID is `oregano/knowledge-postgres` version `3.0.0`.
Agents do not depend on that ID. They use provider-neutral Capabilities:

| Capability | Mode | Contract |
|---|---|---|
| `knowledge.search` | read, R0 | bounded query and up to 20 cited fragments |
| `knowledge.get` | read, R0 | exact Handbook-relative identity, with no fuzzy widening |
| `knowledge.traverse` | read, R0 | deterministic inbound/outbound traversal, depth at most 5 and nodes at most 100 |

The standard Tool grants are `oregano:knowledge/search`,
`oregano:knowledge/get`, and `oregano:knowledge/traverse`, all at version
`3.0.0`. A Workspace must explicitly grant each Tool and allow
its Capability; the Instance must bind it to a compatible Connector.

## 6. Retrieval, graph, and citations

Retrieval supports explicit `lexical` and `hybrid` modes. An active,
Core-resolved subject and its Core-derived stable groups are mandatory. Access
policy is evaluated before either candidate set is produced; denied fragments
cannot affect ranks, fusion, excerpts, citations, result counts, or model
context. Lexical retrieval requires no provider credential. Hybrid retrieval combines lexical and semantic ranks
with reciprocal-rank fusion using constant 60, then returns only the best
fragment per document. Equal scores sort by path and line. Results are bounded
to 20 documents. The default adapter is the deterministic 256-dimensional
`oregano/local-hash-embedding@1.0.0`; it performs no network access and is a
replaceable similarity baseline, not a claim of model-grade semantics.

An embedding policy is `disabled`, `local`, or `external`. An external adapter
MUST fail closed unless the Instance policy identifies it and explicitly allows
data egress. Adapter failure or an unavailable `pgvector` index MUST retain
lexical retrieval and report `embedding-disabled`, `embedding-unavailable`, or
`vector-index-unavailable`. No silent mode change is allowed.

Each hit contains lexical and semantic ranks when applicable, an excerpt,
explicit stale/contested signals, and a citation with snapshot hash, OKF path,
fragment ID, heading, start/end line, and content digest. Zero-result and
no-active-snapshot states are explicit gaps. Retrieval regression ledgers are
versioned query sets with expected paths, actual paths, recall, mode, and
degradation evidence.

The bundle graph consists only of validated relative Markdown links between
OKF documents. Backlinks are reverse projections. Traversal is deterministic
breadth-first search, includes the start path, and is hard-bounded to depth 5
and 100 nodes. Unknown identities and truncation are explicit. Graph edges and
embeddings are derived projections and MUST be rebuildable from the exact
bundle. Authorization removes denied nodes and their incident edges before
traversal, so an inaccessible start is indistinguishable from an unknown path
and protected adjacency cannot leak through counts or truncation.

## 7. Authorization boundary

Every read carries one canonical subject resolved by Core from the active
roster. Groups are stable IDs from roster policy and optional verified Instance
membership mappings; Tool input, display names, paths, tags, and model text
cannot assert identity or group membership. Missing, unknown, inactive,
unresolved, or revoked subjects fail closed.

Every Source has a root policy. Objects may preserve or narrow their parent but
never widen it. Derived objects and graph views use the intersection of every
supporting policy. Explicit deny wins over allow. `public` and `company` admit
an active resolved subject; `team`, `restricted_group`, `individual`, and
`private` require a matching allow. Revoked and unknown policies deny.
Quarantined objects require an explicit `admin` grant through the reserved
`companyos:knowledge-admin` group.

Authorization runs before lexical and vector candidate generation, rank
fusion, exact hydration, graph traversal, citation rendering, review display,
and model-context delivery. Exact get and traversal make an unauthorized
identity indistinguishable from an unknown one. Permit and deny decisions are
audited with principal, group IDs, policy IDs, permission, outcome, reason, and
a hashed object identity; queries, excerpts, source payload, and protected
content are never stored in access-decision evidence.

## 8. Repository Source Connector

The maintained read-only Source Connector is
`oregano/github-repository-source@1.0.0`. It accepts only repository Markdown
under one declared path prefix, with `data_class: business` and
`personal_data: false`. A Workspace requirement declares the stable source ID,
data owner, retention, legal-hold policy, path and size bounds, and freshness
threshold. The Instance binding declares repository owner/name/ref,
`contents:read`, and an `env:NAME` SecretRef. A credential value MUST NOT be
stored in the Workspace, binding row, receipt, envelope, log, or Artifact.

Source retention is explicit: `retention: retain` keeps every fetched object
version without an automatic content-redaction deadline, including after a
complete inventory observes provider deletion. `retention_days: N` is the
finite alternative. Purge MUST be a no-op for `retain`; legal hold remains a
separate temporary deletion control and MUST NOT stand in for indefinite
retention.

The Connector verifies the exact repository identity, enumerates an immutable
Git tree with an integrity-protected cursor, fetches bounded UTF-8 blobs, and
uses GET requests only. Pagination is at most 1,000 objects per page. Transient
HTTP reads retry at most three times. A truncated tree, invalid cursor, identity
mismatch, oversized object, non-Markdown object, or invalid encoding fails
closed. It never accepts a partial inventory as complete.

Every verify, enumerate, fetch, reconcile, revoke, and delete operation has a
digest-bound receipt. Source object versions are immutable; the current
inventory records presence or provider deletion. A complete fresh inventory
may reconcile missing identities as deleted. A resumed or bounded partial run
defers reconciliation to a later complete-from-start run to avoid false
deletion. Source material remains a raw envelope and produces no more than
three review candidates per cycle. Human acceptance produces only a governed
Workspace proposal; it cannot write or activate OKF.

## 9. Runtime Observations

A Runtime Observation is temporary shared business evidence bound to subject,
content digest, time, run, Agent, and evidence. It requires
`personal_data: false`, may expire, and may identify an observation it
supersedes. Status is `active`, `superseded`, `expired`,
`deletion-requested`, `deleted`, or `legal-hold`.

Only active observations can enter the maximum-three review queue. Promotion
uses the same attributable human decision and governed Workspace proposal as
other raw sources. Observations never enter an active bundle directly. A
deletion request records principal and reason. Active legal hold blocks
deletion; release restores the pending deletion state. Applying an authorized
deletion redacts content and evidence while retaining transition evidence.

## 10. Additive Company Brain Phase 1 foundation

The complete inactive Company Brain Phase 1 schema foundation is additive to the existing
OKF snapshot contract. It does not expose a new Agent-facing read or write path
and does not relax the V1 access boundary in Section 7. Fine-grained
authorization remains a prerequisite for admitting or retrieving sensitive
Brain content.

The Core taxonomy pack version `1.0.0` registers exactly these 19 base Page
types: `person`, `company`, `media`, `tweet`, `social-digest`, `analysis`,
`atom`, `concept`, `source`, `deal`, `email`, `slack`, `meeting`,
`conversation`, `writing`, `project`, `note`, `event`, and `diary`. Page types
are registry rows rather than a closed database enum. Registered extension and
legacy types therefore preserve the same provenance, versioning, retention,
and authorization contract without a schema rewrite. Classification falls back
to `note` only when no narrower registered type is proven.

Pages have stable source-specific identity and immutable versions. Page
verification is separate from future cross-source entity identity. Each Page
and version carries an access-policy identity even while the tables remain
unexposed.

Claims use two memory classes:

- a `fact` is active hot memory owned by one principal with an explicit
  principal or session scope; and
- a `take` is durable epistemic memory with exactly one resolved or explicitly
  unresolved Holder.

Source-literal Takes may be active only with exact evidence and a resolved
Holder. Deterministic Fact consolidation additionally requires a durable
consolidation receipt. A model-derived Take remains `proposed` regardless of
extraction confidence. Speaker, author, subject, approver, owner, beneficiary,
and affected-party relations are stored separately from the primary epistemic
Holder. Claim creation is digest-idempotent, and evidence locators are retained
with the Claim.

Outcome grading produces an evidence-bound resolution proposal. Outcome
evidence MUST postdate the Claim and MUST include evidence independent from the
Claim's own source version. Resolution proposals cannot auto-apply in this
increment. A later activation, grading, or resolution policy requires its own
reviewed contract and migration.

The additive Page and Claim relations are `page_type_registry`,
`page_type_aliases`, `pages`, `page_versions`, `holders`, `claims`,
`claim_evidence`, `claim_relations`, `claim_consolidations`, and
`claim_resolution_proposals`. Claims additionally reserve typed value,
ontology-mapping, notability, bidirectional supersession, and canonical
resolution fields. These fields do not make a resolution proposal
auto-applicable.

The provider-neutral `BrainStore` persists and retrieves registered Page types,
immutable Page versions, current Page pointers, Holders, Claims with exact
evidence, and Claim resolution proposals. The maintained implementations are
an in-memory conformance store and a Postgres store. Page-type, Page-version,
Holder, Claim, evidence, and proposal identity reuse with different content
fails closed. Exact retries are no-ops. Page versions advance contiguously and
never delete prior versions. The Postgres writer uses serializable transactions
for multi-row writes and the existing `DATABASE_URL`; it does not introduce a
second state authority.

This persistence contract remains internal. No standard Tool or Capability can
read or write these rows until fine-grained authorization and the corresponding
filtered retrieval contract are separately implemented and qualified.

Cross-source Entity identity is a separate internal contract from Page
identity. An Entity uses a deterministic stable key and may receive a Page
membership directly only from a stable provider identifier, an
administrator-maintained mapping, or another deterministic rule with an exact
receipt. A reviewed proposal decision is the fourth permitted proof path.
Every membership retains the member Page's access-policy identity; linking
Pages does not itself create a wider policy or an Agent-visible derived view.

Name similarity, embedding similarity, and model judgment create only an
`EntityIdentityProposal`. A model-judgment proposal additionally requires exact
model, prompt, and extraction-run provenance. A proposal creates no membership
until one attributable `accepted` decision binds the candidate Page, target
Entity, and decision receipt. Rejection creates no membership, a conflicting
second decision fails closed, and one source-specific Page cannot silently join
two Entity identities. Page versions remain independent and immutable after
membership.

The additive relations are `entity_identities`, `entity_identity_members`, and
`entity_identity_proposals`. Proposal decisions are retained on the exact
proposal row; accepted membership carries the decision receipt. These internal
relations are not part of Agent-facing retrieval before policy-intersection and
fine-grained authorization are implemented.

The remaining Phase 1 relations reserve the complete durable boundary without
claiming their later processing behavior: `acl_policies`, `acl_entries`,
`external_principals`, `raw_assets`, `merge_ledger`,
`calibration_profiles`, `timeline_events`, `knowledge_edges`, `syntheses`,
`synthesis_versions`, `promotion_candidates`, `decision_receipts`, `sessions`,
`session_corpus`, `session_cursors`, `extraction_runs`, and
`brain_export_ledger`. Together with the existing snapshot, source,
observation, Page, Claim, and Entity relations, the Phase 1 base contains 44
required tables under `companyos_knowledge` plus optional vector projections.

Database manifest `companyos-postgres@1.2.0` is an additive successor to the
immutable `1.1.0` Phase 1 and `1.0.0` foundation definitions. It adds stable
principal groups, group membership evidence, and payload-free access-decision
events for 47 required Knowledge tables. Existing manifest rows are retained. Existing
Sources and Source Object versions receive the reserved
`policy:quarantine` root, existing unknown Page and Claim policy identifiers
are registered as quarantined legacy policies, and Claim evidence defaults to
quarantine. Existing Handbook projections retain the separate company
Handbook policy. The Phase 2 runtime enforces policy intersection,
narrowing-only inheritance, pre-rank filtering, graph filtering, restricted
Handbook policy, review authorization, and payload-free access auditing.
Sensitive Connectors still require their own provider-ACL mapping conformance
before activation.

## 11. Compatibility and recovery

OKF, bundle, provider, embedding, graph, Source Connector, Runtime Observation,
Capability, Tool, and review contracts version independently. Unknown major
versions fail closed. Documents, fragments, graph edges, lexical indexes, and
embeddings are rebuildable from an exact bundle. Review decisions, source
receipts, object-version provenance, observation transitions, deletion
requests, legal holds, and activation receipts are durable Instance evidence.
Recovery restores the existing database, rebuilds derived indexes for a named
bundle, verifies it, and explicitly activates it; it never treats an arbitrary
surviving index or Source Envelope as company authority. Disabling hybrid mode
or revoking a Source binding does not delete this evidence.
