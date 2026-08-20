---
type: tool
description: Stop one campaign asset without increasing approved maximum spend.
version: 1.0.0
risk: R2
data_class: business
idempotency: input-hash
capabilities: [marketing-campaign.stop-asset]
input_schema:
  type: object
  additionalProperties: false
  required: [campaign_key, asset]
  properties:
    campaign_key: { type: string, minLength: 1 }
    asset: { type: string, minLength: 1 }
output_schema: { type: object }
evidence: [campaign_id, stopped_asset, max_spend]
failure: Preserve the current campaign allocation and report the refusal.
---
# Stop asset

This reversible action cannot raise the approved spend ceiling.
