---
type: tool
description: Retain the Agent report, observed write receipts or shared triage skip
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - task
    - route
    - execution
  properties:
    task:
      type: object
    route:
      enum:
        - skip
        - reasoning
        - deep
    execution:
      type:
        - object
        - "null"
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - source_identity
    - source_version
    - route
    - pages
    - receipts
    - indexed_revision
    - verification
    - gaps
  properties:
    status:
      enum:
        - processed
        - ingested
        - reconciled
        - skipped
    agent_report:
      description: Agent-authored final text; not an independent quality verdict.
      type: string
      minLength: 1
    verification_mode:
      enum:
        - agent-skill
    source_identity:
      type: string
      minLength: 1
      maxLength: 2000
    source_version:
      type: string
      minLength: 1
      maxLength: 2000
    route:
      enum:
        - skip
        - reasoning
        - deep
    pages:
      type: array
      maxItems: 200
      items:
        type: object
    receipts:
      type: array
      maxItems: 256
      items:
        type: object
    indexed_revision:
      type:
        - object
        - "null"
    verification:
      type: array
      maxItems: 6
      items:
        type: object
    gaps:
      type: array
      maxItems: 100
      items:
        type: string
        minLength: 1
        maxLength: 2000
evidence:
  - result
failure: Return bounded validation feedback or reject incomplete evidence.
---
