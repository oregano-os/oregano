---
type: tool
description: Validate resolved identities against authorized read receipts
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - results
  properties:
    requests:
      type: array
      maxItems: 40
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - prompt_path
          - data
        properties:
          key:
            type: string
            minLength: 1
            maxLength: 50
          prompt_path:
            type: string
            minLength: 1
            maxLength: 500
          data:
            type: object
    results:
      type: array
      maxItems: 40
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - output
        properties:
          key:
            anyOf:
              - type: string
              - type: integer
          output:
            type: object
            additionalProperties: false
            required:
              - text
            properties:
              text:
                type: string
                minLength: 1
                maxLength: 20000
output_schema:
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
evidence:
  - status
  - meetings
failure: Reject incomplete, stale, oversized or ungrounded resolution evidence.
  No source or page may be truncated.
---

Prepare only the next bounded phase. This Tool cannot write Brain knowledge or declare ingestion complete.
