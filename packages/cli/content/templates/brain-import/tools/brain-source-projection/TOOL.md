---
type: tool
description: Select an existing Records projection from reviewed source identity prefixes
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required: [identity, default_projection, routes]
  properties:
    identity: {type: string, minLength: 1, maxLength: 2000}
    default_projection: {type: string, pattern: "^[a-z][a-z0-9-]{0,63}$"}
    routes:
      type: array
      maxItems: 32
      items:
        type: object
        additionalProperties: false
        required: [identity_prefix, projection]
        properties:
          identity_prefix: {type: string, minLength: 1, maxLength: 1000}
          projection: {type: string, pattern: "^[a-z][a-z0-9-]{0,63}$"}
output_schema:
  type: object
  additionalProperties: false
  required: [projection_id]
  properties:
    projection_id: {type: string, pattern: "^[a-z][a-z0-9-]{0,63}$"}
evidence: [result]
failure: Reject invalid or overlapping reviewed routes before a Records read.
---
