---
type: tool
description: Group the current authoritative Monday Sprint items by the current included Contributors and produce
  structured evidence plus a deterministic Markdown block for the handoff template.
version: 2.1.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - participants
    - work_items
  properties:
    participants:
      description: Rows of the participants projection for the current Sprint.
      type: array
      items:
        $ref: "#/$defs/participant_row"
    work_items:
      description: Rows of the work-items projection for Monday's authoritative Sprint master group.
      type: array
      items:
        $ref: "#/$defs/work_item_row"
    empty_message:
      type: string
      minLength: 1
      maxLength: 500
  $defs:
    participant_row:
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
            - participant_id
            - display_name
            - included
          properties:
            participant_id:
              type: string
              minLength: 1
            display_name:
              type: string
              minLength: 1
            included:
              type: boolean
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
            - title
            - assignee_ids
            - url
          properties:
            work_item_id:
              type: string
              minLength: 1
            title:
              type: string
              minLength: 1
            assignee_ids:
              type: array
              items:
                type: string
            url:
              type: string
              minLength: 1
output_schema:
  type: object
  additionalProperties: false
  required:
    - groups
    - unassigned_work_items
    - work_items_by_contributor
    - participant_count
    - unique_work_item_count
    - unassigned_count
  properties:
    groups:
      description: Included Contributors in stable display-name order, including Contributors with no current Sprint items.
      type: array
      items:
        type: object
        required:
          - participant_id
          - display_name
          - work_items
        properties:
          participant_id:
            type: string
          display_name:
            type: string
          work_items:
            type: array
            items:
              $ref: "#/$defs/grouped_work_item"
    unassigned_work_items:
      description: Current Sprint items whose assignees do not match any included Contributor.
      type: array
      items:
        $ref: "#/$defs/grouped_work_item"
    work_items_by_contributor:
      description: Deterministic Markdown ready for direct {{path}} substitution by the Workspace template.
      type: string
    participant_count:
      type: integer
      minimum: 0
    unique_work_item_count:
      type: integer
      minimum: 0
    unassigned_count:
      type: integer
      minimum: 0
  $defs:
    grouped_work_item:
      type: object
      required:
        - work_item_id
        - title
        - url
        - shared
      properties:
        work_item_id:
          type: string
        title:
          type: string
        url:
          type: string
        shared:
          type: boolean
evidence:
  - groups
  - unassigned_work_items
failure: A row without its required values is an error. Pure computation.
---
# Monday handoff view

Monday's Sprint master group is the only source of work scope. The Tool joins
its current cards to the current included participant rows and groups them in
stable display-name order. A card assigned to multiple included Contributors
appears under each of them and is marked `shared`. A card with no matching
included Contributor appears under `Unassigned`. Contributors with no cards
still appear with `No current Sprint items`.

The Tool also renders the deterministic `work_items_by_contributor` Markdown
block consumed by the Workspace template. That formatting is company-specific
computation and therefore stays in the Workspace; Core needs no Sprint-aware
renderer or template loop. Friday submissions and `NEXT WEEK` plans are not
inputs and no comparison or disagreement is produced.
