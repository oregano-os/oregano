---
type: tool
description: Prepare complete source context and fixed write provenance for one
  continuing Agent task
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
    - directories
    - processing_instant
  properties:
    prepared:
      type: object
    gate:
      type: object
    history:
      type: object
    directories:
      type: object
    processing_instant:
      type: string
      minLength: 1
      maxLength: 40
output_schema:
  type: object
  additionalProperties: false
  required:
    - route
    - model_profile
    - model_task
    - task
    - provenance
  properties:
    route:
      enum:
        - skip
        - reasoning
        - deep
    task:
      type: object
    model_profile:
      type: string
      enum: [reasoning, deep]
    model_task:
      type: string
      enum: [brain.ingest, brain.ingest.deep]
    provenance:
      type: object
      additionalProperties: false
      required: [source_id, source_version, action, evidence]
      properties:
        source_id: {type: string, minLength: 1, maxLength: 256}
        source_version: {type: string, minLength: 1, maxLength: 256}
        action: {type: string, minLength: 1, maxLength: 256}
        evidence: {type: array, minItems: 1, maxItems: 16, items: {type: string, minLength: 1, maxLength: 160}}
evidence:
  - result
failure: Return bounded validation feedback or reject incomplete evidence.
---
