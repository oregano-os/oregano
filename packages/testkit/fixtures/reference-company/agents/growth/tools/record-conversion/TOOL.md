---
type: tool
description: Record one synthetic conversion through the bound Capability.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: [conversion.record]
input_schema:
  type: object
  additionalProperties: false
  required: [campaign_key, asset, conversion_id]
  properties:
    campaign_key: { type: string, minLength: 1 }
    asset: { type: string, minLength: 1 }
    conversion_id: { type: string, minLength: 1 }
output_schema:
  type: object
  additionalProperties: false
  required: [conversion_id, recorded]
  properties:
    conversion_id: { type: string }
    recorded: { type: boolean }
evidence: [conversion_id, recorded]
failure: Return the Connector error and preserve the idempotency key.
---
# Record conversion

Fixture conversions contain no personal data.
