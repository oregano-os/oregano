---
type: tool
description: Retain complete authorized identity and meeting-search receipts
  without guessing a match.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - normalization
    - entity_results
    - search_results
  properties:
    normalization:
      type: object
      additionalProperties: false
      required:
        - status
        - meetings
        - lookups
        - meeting_searches
        - gaps
      properties:
        status:
          type: string
          enum:
            - triage-skipped
            - normalization-proposed
        meetings:
          type: array
          maxItems: 40
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - start
              - end
              - title
              - date
              - time
              - duration
              - attendees
              - subjects
            properties:
              key:
                type: string
                minLength: 1
                maxLength: 50
              start:
                type: integer
                minimum: 0
              end:
                type: integer
                minimum: 1
              title:
                type: string
                minLength: 1
                maxLength: 160
              date:
                type: string
                minLength: 1
                maxLength: 10
              time:
                type:
                  - string
                  - "null"
              duration:
                type:
                  - string
                  - "null"
              attendees:
                type: array
                items:
                  type: object
              subjects:
                type: array
                items:
                  type: object
        lookups:
          type: array
          maxItems: 200
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - name
              - type
            properties:
              key:
                type: string
                minLength: 1
                maxLength: 50
              name:
                type: string
                minLength: 1
                maxLength: 160
              type:
                type: string
                enum:
                  - person
                  - company
                  - concept
                  - meeting
        meeting_searches:
          type: array
          maxItems: 200
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - query
            properties:
              key:
                type: string
                minLength: 1
                maxLength: 50
              query:
                type: string
                minLength: 1
                maxLength: 500
        gaps:
          type: array
          maxItems: 200
          items:
            type: string
            minLength: 1
            maxLength: 2000
    entity_results: &a1
      type: array
      maxItems: 200
      items:
        type: object
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
    search_results: *a1
output_schema:
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
evidence:
  - status
  - entities
  - meeting_searches
  - indexed_revision
failure: Reject missing, duplicated, truncated or inconsistent read evidence.
  Ambiguous identities stay unresolved.
---

Validate the read receipts; semantic identity resolution and filing remain pending.
