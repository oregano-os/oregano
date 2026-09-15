---
type: tool
description: Require supported correction verdicts before standard Brain writes
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - results
  properties:
    requests: &a1
      type: array
      maxItems: 200
      items:
        type: object
    results: *a1
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - reports
  properties:
    status:
      type: string
      enum:
        - reconciliation-verified
        - triage-skipped
    reports: *a1
evidence:
  - status
  - reports
failure: Stop incomplete original evidence, stale page reads or unchecked source
  correction. Retain completed attempts and effects for explicit continuation.
---

Require supported correction verdicts before standard Brain writes. Uses existing governed source and page evidence; it grants no provider or Git authority.
