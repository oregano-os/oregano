---
type: tool
description: From the planning candidates derive one focused question per single owner with missing required fields and
  the readiness label update set. Mirrors the current Core readiness read model, which considers every candidate,
  changed or not.
version: 2.1.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - work_items
    - required_fields
    - ready_status
    - planned_status
  properties:
    work_items:
      description: Rows of the work-items projection restricted to the planning group in Planned or Ready status.
      type: array
      items:
        $ref: "#/$defs/work_item_row"
    required_fields:
      type: array
      items:
        type: string
    ready_status:
      type: string
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
            - fields
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
    - summary
    - questions
    - updates
  properties:
    outcome:
      type: string
      enum:
        - none
        - some
    summary:
      type: object
      required:
        - candidate_count
        - ready_count
        - missing_count
      properties:
        candidate_count:
          type: integer
        ready_count:
          type: integer
        missing_count:
          type: integer
    questions:
      description: At most one entry per participant; only items with exactly one assignee.
      type: array
      items:
        type: object
        required:
          - participant_id
          - work_item_id
          - missing_fields
          - question
        properties:
          participant_id:
            type: string
          work_item_id:
            type: string
          missing_fields:
            type: array
            items:
              type: string
          question:
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
  - summary
failure: A row without its required values is an error, never a silently skipped item. Pure computation.
---
# Readiness view

Rules from the current Core read model, kept as the parity oracle: an item is
ready when every required field is present and it has exactly one assignee;
zero and multiple assignees add the missing `assignee` requirement. An item labeled `ready_status`
that lost a required field is invalidated back to `planned_status`; a
question goes only to an item's single owner, once per owner per run. The
label update set never changes the group. The workflow reads the candidates
without a change filter, so an unchanged incomplete backlog item is included.
