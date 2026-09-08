---
type: tool
description: Group incomplete Sprint items by single owner for a nudge and prepare the batch-update `updates` array that
  would move ownerless or still-incomplete items back to Planned.
version: 1.1.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - work_items
    - planned_status
  properties:
    work_items:
      description: Rows of the work-items projection.
      type: array
      items:
        $ref: "#/$defs/work_item_row"
    planned_status:
      type: string
  $defs:
    work_item_row:
      type: object
      required:
        - record_id
        - values
      properties:
        record_id:
          type: string
        values:
          type: object
          required:
            - work_item_id
            - assignee_ids
            - status
            - provider_version
          properties:
            work_item_id:
              type: string
              minLength: 1
            assignee_ids:
              type: array
              items:
                type: string
            status:
              type: string
            provider_version:
              type: string
              minLength: 1
            fields:
              type: object
              description: Present required-field values keyed by field name
output_schema:
  type: object
  additionalProperties: false
  required:
    - outcome
    - nudges
    - candidate_ids
    - updates
  properties:
    outcome:
      type: string
      enum:
        - none
        - some
    nudges:
      type: array
      items:
        type: object
        required:
          - participant_id
          - work_item_ids
          - items_text
        properties:
          participant_id:
            type: string
          work_item_ids:
            type: array
            items:
              type: string
          items_text:
            type: string
    candidate_ids:
      type: array
      items:
        type: string
    updates:
      description: Exactly the `updates` input of oregano:work-items/batch-update; empty only when outcome is none.
      type: array
      items:
        type: object
        required:
          - work_item_id
          - expected_version
          - changes
        additionalProperties: false
        properties:
          work_item_id:
            type: string
          expected_version:
            type: string
          changes:
            type: object
            required:
              - status
            properties:
              status:
                type: string
evidence:
  - outcome
failure: A row without its required values is an error. Pure computation.
---
# Stale item triage

Used twice in `board-hygiene.md`. `outcome` lets the workflow route without
an expression and guarantees the batch Tool never receives an empty array.
