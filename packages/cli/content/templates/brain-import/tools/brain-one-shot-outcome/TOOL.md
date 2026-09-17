---
type: tool
description: Retain exact source-version completion from a settled one-shot Brain write and saved-page read-back.
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
    - synthesis
    - route
  properties:
    task:
      type: object
    synthesis:
      type: object
    route:
      type: string
      minLength: 1
      maxLength: 20
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
  properties:
    status:
      enum:
        - ingested
        - reconciled
    source_identity:
      type: string
    source_version:
      type: string
    route:
      type: string
    pages:
      type: array
    receipts:
      type: array
    indexed_revision:
      type: object
    verification:
      type: array
    gaps:
      type: array
evidence:
  - status
  - source_identity
  - source_version
  - route
  - pages
  - receipts
  - indexed_revision
failure: Reject mismatched source identity or unsettled Git/index receipts.
---

Record completion only after the one-shot Tool has read each saved page back.
