---
type: tool
description: Read every unresolved identity and deduplication candidate in full
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - lookups
  properties:
    lookups:
      type: object
      additionalProperties: false
      required:
        - status
        - entities
        - meeting_searches
        - indexed_revision
      properties:
        status:
          type: string
          enum:
            - triage-skipped
            - lookup-evidence-ready
        entities:
          type: array
          items:
            type: object
        meeting_searches:
          type: array
          items:
            type: object
        indexed_revision:
          type:
            - object
            - "null"
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
        properties:
          key:
            type: string
            minLength: 1
            maxLength: 50
          slug:
            type: string
            minLength: 1
            maxLength: 160
evidence:
  - requests
failure: Reject incomplete, stale, oversized or ungrounded resolution evidence.
  No source or page may be truncated.
---

Prepare only the next bounded phase. This Tool cannot write Brain knowledge or declare ingestion complete.
