---
type: tool
description: Fixture-only deterministic permit status calculation.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required: [permit_id]
  properties:
    permit_id: { type: string, minLength: 1 }
output_schema:
  type: object
  additionalProperties: false
  required: [normalized_status]
  properties:
    normalized_status: { type: string, enum: [unknown] }
evidence: [normalized_status]
failure: Return unknown for a syntactically valid fixture permit.
---

# Check permit status

This deliberately simple Company Tool proves that `company:` grants resolve
relative to the owning agent. It performs no provider access and uses no
runtime or environment APIs.
