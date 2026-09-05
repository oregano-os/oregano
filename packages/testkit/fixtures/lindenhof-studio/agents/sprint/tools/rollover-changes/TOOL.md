---
type: tool
description: Turn the open work items of a close view into the exact `updates` array of oregano:work-items/batch-update that a human approves and one batch call applies.
version: 2.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required: [open_work_items, target_sprint_id]
  properties:
    open_work_items:
      type: array
      items:
        type: object
        required: [work_item_id, provider_version]
        properties:
          work_item_id: { type: string }
          provider_version: { type: string }
    target_sprint_id: { type: string }
output_schema:
  type: object
  additionalProperties: false
  required: [outcome, updates]
  properties:
    outcome: { type: string, enum: [none, some] }
    updates:
      description: Exactly the `updates` input of oregano:work-items/batch-update. The approval digest is the digest of this array. Empty only when outcome is none; the workflow routes to end before the Tool would receive an empty array.
      type: array
      items:
        type: object
        required: [work_item_id, expected_version, changes]
        additionalProperties: false
        properties:
          work_item_id: { type: string }
          expected_version: { type: string }
          changes:
            type: object
            required: [sprint]
            properties:
              sprint: { type: string }
evidence: [outcome, updates]
failure: Pure computation.
---
# Rollover changes

Exists so that the human decision binds the **complete effect**: item,
expected version, target field, and target value, in the exact shape the batch
Tool consumes. `resource_binding` is supplied by the workflow from
configuration, not by this Tool.

Inventory decision (D23): borderline; a generic "rows to batch updates"
standard Tool could replace it. Kept because the field name is company
mapping.
