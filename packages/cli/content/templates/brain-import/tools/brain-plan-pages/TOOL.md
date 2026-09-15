---
type: tool
description: Plan source, meeting and entity pages from reviewed resolution
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - prepared
    - resolution
    - directories
  properties:
    prepared:
      type: object
      additionalProperties: false
      required:
        - source
        - source_complete
        - expected_segments
        - segments
      properties:
        source: &a1
          type: object
          additionalProperties: false
          required:
            - identity
            - version
            - kind
            - original_url
            - occurred_at
            - context
          properties:
            identity:
              type: string
              minLength: 1
              maxLength: 2048
            version:
              type: string
              minLength: 1
              maxLength: 2048
            kind:
              type: string
              enum:
                - meeting
                - discussion
            original_url:
              type: string
              minLength: 1
              maxLength: 4000
            occurred_at:
              type: string
              minLength: 1
              maxLength: 40
            context:
              type: object
        source_complete:
          const: true
        expected_segments:
          type: array
          items:
            type: string
            minLength: 1
            maxLength: 50
          minItems: 1
          maxItems: 1000
        segments:
          type: array
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - data
            properties:
              key:
                type: string
                minLength: 1
                maxLength: 50
              data:
                type: object
                additionalProperties: false
                required:
                  - source
                  - segment
                properties:
                  source: *a1
                  segment:
                    type: object
                    additionalProperties: false
                    required:
                      - id
                      - start
                      - end
                      - text
                    properties:
                      id:
                        type: string
                        minLength: 1
                        maxLength: 50
                      start:
                        type: integer
                        minimum: 0
                      end:
                        type: integer
                        minimum: 1
                      text:
                        type: string
                        minLength: 1
                        maxLength: 60000
          minItems: 1
          maxItems: 1000
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
    directories:
      type: object
      additionalProperties: false
      required:
        - person
        - company
        - concept
        - meeting
        - source
      properties:
        person:
          type: string
          minLength: 1
          maxLength: 40
        company:
          type: string
          minLength: 1
          maxLength: 40
        concept:
          type: string
          minLength: 1
          maxLength: 40
        meeting:
          type: string
          minLength: 1
          maxLength: 40
        source:
          type: string
          minLength: 1
          maxLength: 40
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - targets
    - meetings
    - evidence
  properties:
    status:
      type: string
      enum:
        - triage-skipped
        - page-targets-planned
    targets:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - slug
          - type
          - name
          - existing
        properties:
          key:
            type: string
            minLength: 1
            maxLength: 50
          slug:
            type: string
            minLength: 1
            maxLength: 160
          type:
            type: string
            minLength: 1
            maxLength: 40
          name:
            type: string
            minLength: 1
            maxLength: 160
          existing:
            type: boolean
    meetings:
      type: array
      maxItems: 40
      items:
        type: object
    evidence:
      type:
        - object
        - "null"
evidence:
  - status
  - targets
  - meetings
  - evidence
failure: Reject missing source, changed page reads, incomplete drafts and
  exceeded evidence bounds. No Brain writes occur.
---

Prepare only this phase. A page draft is not an ingested source; entity propagation, semantic verification and actual standard Brain write receipts remain required.
