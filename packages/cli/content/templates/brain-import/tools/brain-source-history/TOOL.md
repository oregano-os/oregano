---
type: tool
description: Check complete prior source-version outcomes before paid processing
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities:
  - evidence.query
input_schema:
  type: object
  additionalProperties: false
  required:
    - identity
    - version
    - history_from
    - cutoff
    - workflow_id
  properties:
    identity: &a1
      type: string
      minLength: 1
      maxLength: 1000
    version: *a1
    history_from:
      type: string
      format: date-time
    cutoff:
      type: string
      format: date-time
    workflow_id: *a1
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - prior_runs
    - prior_skipped_versions
    - requests
  properties:
    status:
      type: string
      enum:
        - no-prior-knowledge
        - reconciliation-required
    prior_runs:
      type: array
      maxItems: 100
      items: *a1
    prior_skipped_versions:
      type: array
      maxItems: 100
      items: *a1
    requests:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - slug
        properties:
          key: &a2
            type: string
            minLength: 1
            maxLength: 1000
          slug: *a2
evidence:
  - status
  - prior_runs
  - prior_skipped_versions
  - requests
failure: Block incomplete prior runs or incomplete evidence; retain exact
  affected page coverage for required reconciliation.
---

Read earlier outcomes from existing scoped Workflow state. A previous ingestion requires explicit source-claim reconciliation; a new low-value score cannot certify that old claims remain supported.
