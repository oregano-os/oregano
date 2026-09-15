---
type: tool
description: Prepare correction of prior knowledge even when the current source
  is triage-skipped
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - prepared
    - gate
    - history
    - results
    - evidence_reads
    - prompts
    - instant
  properties:
    prepared: &a1
      type: object
    gate: *a1
    history: *a1
    results: &a2
      type: array
      maxItems: 200
      items: *a1
    evidence_reads: *a2
    prompts: *a1
    instant:
      type: string
      format: date-time
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - targets
    - evidence
    - gate
  properties:
    requests:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - prompt_path
          - data
        properties:
          key:
            type: string
            minLength: 1
            maxLength: 50
          prompt_path:
            type: string
            minLength: 1
            maxLength: 500
          data:
            type: object
    targets: *a2
    evidence:
      type:
        - object
        - "null"
    gate:
      type: object
      additionalProperties: false
      required:
        - route
        - coverage_complete
      properties:
        route:
          type: string
          enum:
            - skip
            - reasoning
            - deep
        coverage_complete:
          const: true
evidence:
  - requests
  - targets
  - evidence
  - gate
failure: Stop incomplete original evidence, stale page reads or unchecked source
  correction. Retain completed attempts and effects for explicit continuation.
---

Prepare correction of prior knowledge even when the current source is triage-skipped. Uses existing governed source and page evidence; it grants no provider or Git authority.
