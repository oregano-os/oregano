---
type: tool
description: Launch the bounded campaign through the bound marketing Capability.
version: 1.0.0
risk: R4
data_class: business
idempotency: input-hash
capabilities: [marketing-campaign.launch]
input_schema:
  type: object
  additionalProperties: false
  required: [campaign_key, daily_budget, days, assets]
  properties:
    campaign_key: { type: string, minLength: 1 }
    daily_budget: { type: number, minimum: 0 }
    days: { type: integer, minimum: 1 }
    assets: { type: array, items: { type: string } }
output_schema:
  type: object
  additionalProperties: false
  required: [campaign_id, status, max_spend, simulated]
  properties:
    campaign_id: { type: string }
    status: { type: string }
    max_spend: { type: number }
    simulated: { type: boolean }
evidence: [campaign_id, max_spend, simulated]
failure: Do not retry with changed budget or assets; request a new exact approval.
---
# Launch campaign

The human-provided daily budget and duration define the maximum spend.
