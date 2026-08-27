---
document_id: guide.recover-company-knowledge
title: Recover Company Knowledge
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.company-knowledge-v0.2
    - guide.operate-knowledge-provider
---

# Recover Company Knowledge

Curated authority is the exact OKF Workspace commit and its immutable Knowledge
Bundle. Lexical indexes, graph edges, and embeddings are derived projections.
Source Envelopes and Runtime Observations are review evidence, not authority.

## Rebuild derived state

1. Restore the existing Company Instance database through the normal Neon
   backup procedure.
2. Identify the exact Workspace commit and Knowledge Bundle hash.
3. Run `companyos knowledge rebuild --snapshot <bundle-hash>`.
4. Verify the snapshot, run a retrieval regression ledger, and inspect provider
   health.
5. Activate the named verified hash explicitly. To roll back, activate a prior
   verified hash explicitly.

The rebuild writes graph-edge, embedding-count, and vector-availability
evidence. If `pgvector` is unavailable, lexical retrieval remains available
and reports the degradation. Do not create a second database as a recovery
shortcut.

## Preserve durable evidence

Backups must retain snapshots, activation and index runs, review candidates and
decisions, Source Connector receipts and object versions, source inventory and
cursors, Runtime Observations, transition events, deletion requests, and legal
holds. Never reconstruct company authority from an arbitrary surviving search
index.

After restore, verify one known citation, one exact get, one bounded graph
traversal, one zero-result gap, source health for each active binding, and the
status of every open deletion request or legal hold. A live restore exercise is
Instance-specific operational evidence and is not implied by repository tests.

## Recovery qualification

A release recovery receipt binds all of the following without source payloads
or credentials:

- the provider backup receipt and deterministic Brain export-ledger identity;
- the exact Core and Company Workspace commits;
- matching expected and restored durable-state digests;
- the rebuilt projection digest; and
- separate legal-hold, redaction, and governed-purge test receipts.

Do not rerun models to reconstruct prior Page, Claim, synthesis, or decision
output. Restore those immutable outputs and their execution receipts; rebuild
only declared projections. Recovery fails if the durable state digest differs,
even when current model output appears semantically similar.

## Incident sequence

1. Disable affected Knowledge writers, Source bindings, synthesis, and Agent
   retrieval grants without deleting retained evidence.
2. Preserve current database, deployment, queue, access-denial, Connector, and
   model-execution receipts.
3. Determine whether the fault affects source evidence, derived projections,
   authorization, Handbook authority, or only availability.
4. Restore the exact backup into an isolated qualified StateStore context and
   verify the export ledger before traffic or scheduled processing resumes.
5. Rebuild lexical, vector, graph, and salience projections; never widen ACLs
   to make a recovery query succeed.
6. Run authorization, citation-membership, deterministic-fast-path, retrieval,
   legal-hold, redaction, and purge regressions.
7. Re-enable read capabilities before writers, then re-enable each Source and
   scheduled phase with its own health and cursor evidence.
8. Record the recovery receipt, impact, exact commits, remaining gaps, and
   follow-up Change Plan.

Repository tests provide the recovery contract but not a real backup/restore
receipt. Until an exact Instance passes the full exercise, operating readiness
remains `validated`, not `enforced`.
