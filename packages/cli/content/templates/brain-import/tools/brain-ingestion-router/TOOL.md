---
type: tool
description: Select reviewed ingestion instructions by semantic content kind, independently of source transport.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required: [source, routes]
  properties:
    source:
      type: object
      required: [kind]
      properties:
        kind: {type: string}
    routes:
      type: object
output_schema:
  type: object
  additionalProperties: false
  required: [kind, instructions]
  properties:
    kind: {type: string}
    instructions:
      type: array
      minItems: 1
      maxItems: 8
      items: {type: string}
evidence: [result]
failure: Reject unknown content or unavailable publication discovery before any model call.
---
