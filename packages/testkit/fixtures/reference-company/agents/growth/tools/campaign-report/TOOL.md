---
type: tool
description: Read normalized campaign facts without provider-specific fields.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: [marketing-campaign.read-report]
input_schema:
  type: object
  additionalProperties: false
  required: [campaign_key]
  properties:
    campaign_key: { type: string, minLength: 1 }
output_schema: { type: object }
evidence: [campaign_id, observed_at]
failure: Report that normalized facts are unavailable; never invent metrics.
---
# Campaign report

The Connector owns provider translation and evidence.
