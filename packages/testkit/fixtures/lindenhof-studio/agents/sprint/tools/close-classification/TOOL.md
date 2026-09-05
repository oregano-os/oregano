---
type: tool
description: Classify every frozen participant at a cutoff and list open work items with provider versions. Takes
  Company Records rows with typed values. Preserves the current Friday Close classification semantics without carrying
  data into Monday.
version: 6.1.0
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
    - submissions
    - closed_statuses
    - cutoff
    - thread_reference
  properties:
    participants:
      type: array
      items:
        $ref: "#/$defs/participant_row"
    work_items:
      type: array
      items:
        $ref: "#/$defs/work_item_row"
    submissions:
      type: array
      items:
        $ref: "#/$defs/submission_row"
    closed_statuses:
      type: array
      items:
        type: string
    cutoff:
      type: string
      format: date-time
    thread_reference:
      description: The Close thread opened by the workflow. Supplied by the workflow, never derived from submissions, so the
        evidence keeps the thread even when nobody answered.
      type: string
      minLength: 1
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
            - included
            - display_name
          properties:
            participant_id:
              type: string
              minLength: 1
            included:
              type: boolean
            display_name:
              type: string
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
    submission_row:
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
            - content_participant_id
            - accepted_at
            - task_ids
            - well_formed
          properties:
            participant_id:
              type: string
              minLength: 1
            content_participant_id:
              type: string
              minLength: 1
            accepted_at:
              type: string
              format: date-time
            task_ids:
              type: array
              items:
                type: string
            well_formed:
              type: boolean
            next_week:
              type: array
              items:
                type: object
                required:
                  - work_item_id
                properties:
                  work_item_id:
                    type: string
                  note:
                    type: string
output_schema:
  type: object
  additionalProperties: false
  required:
    - outcome
    - cutoff
    - thread_reference
    - states
    - incomplete
    - open_work_items
    - report_text
    - chase_text
    - open_items_text
  properties:
    outcome:
      type: string
      enum:
        - complete
        - incomplete
    cutoff:
      type: string
      format: date-time
    thread_reference:
      type: string
      minLength: 1
    states:
      type: object
      additionalProperties:
        type: string
        enum:
          - complete
          - needs-reformat
          - missing
    incomplete:
      type: array
      items:
        type: string
    open_work_items:
      type: array
      items:
        type: object
        required:
          - work_item_id
          - provider_version
        properties:
          work_item_id:
            type: string
          provider_version:
            type: string
    report_text:
      type: string
    chase_text:
      type: string
    open_items_text:
      type: string
evidence:
  - outcome
  - incomplete
  - cutoff
  - thread_reference
failure: A row without its required values is an error, never a silently excluded participant. Pure computation; never
  retried with changed input.
---
# Close classification

Deterministic and pure. Every row kind has a typed `values` schema; a
participant row without `participant_id` or `included` fails the Tool instead
of disappearing from the report. Rules are those of the current Core read
model, kept as the parity oracle:

- The latest submission accepted at or before `cutoff` counts here.
  Provider fractional precision is preserved, including within one millisecond.
- `complete` requires a well-formed submission whose task set **equals** the
  participant's committed task set.
- `needs-reformat` when a submission exists but is not well formed or its task
  set differs.
- `missing` otherwise.
- `open_work_items` are committed items whose status is not in
  `closed_statuses` (from configuration).
- `thread_reference` is an input from the workflow and is echoed unchanged, so
  the Friday evidence is complete even when no submission arrived by the cutoff.
- `NEXT WEEK` content remains part of the stored Friday submission evidence,
  but this classification does not carry it into or compare it with Monday.

Inventory decision (D23): stays a Company Tool because it encodes the
company's Friday template semantics.
