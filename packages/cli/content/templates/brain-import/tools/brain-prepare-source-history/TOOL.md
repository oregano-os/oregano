---
type: tool
description: Select complete evidence pages for matched meetings
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - resolution
    - requests
    - source_directory
  properties:
    resolution:
      type: object
      additionalProperties: false
      required:
        - status
        - meetings
      properties:
        status:
          type: string
          enum:
            - triage-skipped
            - resolution-reviewed
        meetings:
          type: array
          maxItems: 40
          items:
            type: object
    requests:
      type: array
      maxItems: 200
      items:
        type: object
    source_directory: &a1
      type: string
      minLength: 1
      maxLength: 4000
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
  properties:
    requests:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - slug
          - meeting_keys
        properties:
          key: *a1
          slug: *a1
          meeting_keys:
            type: array
            maxItems: 40
            items: *a1
evidence:
  - requests
failure: Reject missing or changed original-source evidence; retain complete
  source versions and never truncate.
---

Read and compare retained source evidence before any draft or write. This is deterministic preparation, not a completed import.
