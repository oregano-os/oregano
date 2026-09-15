---
type: tool
description: Check saved-page receipts and read-back after incremental Agent writes
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - context
    - facts
  properties:
    context:
      type: object
    facts:
      type: object
      additionalProperties: false
      required:
        - source_identity
        - source_version
        - status
        - pages
        - meetings
        - verification
        - gaps
      properties:
        source_identity:
          type: string
          minLength: 1
          maxLength: 2000
        source_version:
          type: string
          minLength: 1
          maxLength: 2000
        status:
          enum:
            - ingested
            - reconciled
        pages:
          type: array
          maxItems: 200
          items:
            type: string
            minLength: 1
            maxLength: 2000
        meetings:
          type: array
          maxItems: 30
          items:
            type: object
            additionalProperties: false
            required:
              - slug
              - attendees
              - entities
            properties:
              slug:
                type: string
                minLength: 1
                maxLength: 2000
              attendees:
                type: array
                maxItems: 100
                items:
                  type: string
                  minLength: 1
                  maxLength: 2000
              entities:
                type: array
                maxItems: 100
                items:
                  type: string
                  minLength: 1
                  maxLength: 2000
        verification:
          type: array
          maxItems: 6
          items:
            type: object
            additionalProperties: false
            required:
              - check
              - status
              - detail
            properties:
              check:
                enum:
                  - V1
                  - V2
                  - V3
                  - V4
                  - V5
                  - V6
              status:
                enum:
                  - passed
                  - not-applicable
                  - flagged-uncertainty
              detail:
                type: string
                minLength: 1
                maxLength: 2000
        gaps:
          type: array
          maxItems: 100
          items:
            type: string
            minLength: 1
            maxLength: 2000
output_schema:
  type: object
  additionalProperties: false
  required:
    - accepted
    - feedback
  properties:
    accepted:
      type: boolean
    feedback:
      type: string
      maxLength: 2000
evidence:
  - result
failure: Return bounded validation feedback or reject incomplete evidence.
---
