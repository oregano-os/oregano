---
type: skill-reference
description: Normalized input, output, evidence, provenance, and reason-code contract for product discovery analysis.
---
# Analysis contract

## Required input

Use a normalized, tenant-scoped record with:

- `conversation_id`: stable source-independent identifier;
- `source`: provider or import class;
- `source_record_id`: provider record identifier or digest-backed import identifier;
- `occurred_at` and `updated_at`;
- `content_digest`: digest of the analyzed revision;
- `participants`: authorized roles or pseudonymous identifiers when identity is unnecessary;
- `evidence`: ordered segments with stable `evidence_id`, speaker role, and text or approved summary;
- `authorization`: tenant, purpose, allowed data classes, and retention context;
- optional related conversation references supplied by the Company Brain.

Do not continue when tenant scope, source attribution, or authorization is
missing. Do not persist the source transcript as part of the analysis output.

## Required output

Return one analysis envelope:

```yaml
analysis_id: stable identifier
conversation_id: source-independent identifier
content_digest: analyzed revision digest
analysis_revision: positive integer
status: completed | blocked
blocked_reason: null | short reason code
findings:
  - finding_id: stable identifier
    decision: no_feature | feature_candidate | prd_draft
    reason_codes: []
    confidence: low | medium | high
    problem: concise observed problem or null
    target_user: observed role or unknown
    job_to_be_done: observed job or unknown
    desired_outcome: observed outcome or unknown
    evidence:
      - evidence_id: stable input segment reference
        support: short paraphrase or minimal excerpt
    assumptions:
      - "Inference: ..."
    artifact: null | feature candidate or completed PRD draft
provenance:
  source: provider or import class
  source_record_id: provider identifier
  analyzed_at: timestamp
  skill: product-discovery-to-prd
  skill_version: materialized Package or Workspace revision
```

When no justified product opportunity exists, include exactly one
`no_feature` finding. `blocked` is reserved for unusable or unauthorized input;
it is not a substitute for `no_feature`.

## Evidence rules

- Use stable evidence IDs instead of page or line numbers that can change after an edit.
- Keep support text short and necessary. Prefer paraphrase.
- Mark facts from related conversations with their own conversation and evidence references.
- Mark deductions, forecasts, proposed behavior, and prioritization as inference.
- Never include contact details, access data, health information, payment data, or unrelated personal material unless the approved purpose requires it.

## Reason codes

Use one or more stable codes:

- `NO_PRODUCT_PROBLEM`
- `INSUFFICIENT_EVIDENCE`
- `SUPPORT_OR_CONFIGURATION`
- `ALREADY_SUPPORTED`
- `OUT_OF_SCOPE`
- `DUPLICATE_SIGNAL`
- `PRODUCT_PROBLEM_OBSERVED`
- `NEEDS_CORROBORATION`
- `REPEATED_INDEPENDENT_EVIDENCE`
- `SEVERE_BLOCKER`
- `PRD_GATE_MET`
