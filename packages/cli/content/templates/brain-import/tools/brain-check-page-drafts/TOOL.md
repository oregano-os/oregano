---
type: tool
description: Check complete sourced Markdown drafts without declaring semantic verification
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
    - route
  properties:
    requests:
      type: array
      maxItems: 200
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
      maxItems: 200
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
    route:
      type: string
      enum:
        - skip
        - reasoning
        - deep
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - pages
  properties:
    status:
      type: string
      enum:
        - triage-skipped
        - drafts-prepared
    pages:
      type: array
      maxItems: 200
      items:
        type: object
evidence:
  - status
  - pages
failure: Reject missing source, changed page reads, incomplete drafts and
  exceeded evidence bounds. No Brain writes occur.
---

Prepare only this phase. A page draft is not an ingested source; entity propagation, semantic verification and actual standard Brain write receipts remain required.
