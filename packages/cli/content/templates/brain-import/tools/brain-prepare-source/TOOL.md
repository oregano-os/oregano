---
type: tool
description: Prepare complete, bounded source segments from exactly one
  authorized Records version.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - records
    - identity
    - version
    - segment_characters
  properties:
    records:
      type: object
      required:
        - rows
        - access_decision
      properties:
        rows:
          type: array
          items:
            type: object
        access_decision:
          type: object
    identity:
      type: string
      minLength: 1
      maxLength: 2048
    version:
      type: string
      minLength: 1
      maxLength: 2048
    segment_characters:
      type: integer
      minimum: 1000
      maximum: 60000
output_schema:
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
            - article
            - idea
            - document
            - media
            - publication
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
evidence:
  - source
  - source_complete
  - expected_segments
  - segments
failure: Reject incomplete or conflicting evidence. No substitute input or
  implicit provider operation.
---

Prepare complete, bounded source segments from exactly one authorized Records version.
