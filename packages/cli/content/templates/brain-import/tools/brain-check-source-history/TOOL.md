---
type: tool
description: Compare complete original sources and retain richer meeting evidence
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
    - history
    - results
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
    resolution: &a2
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
    history:
      type: object
      additionalProperties: false
      required:
        - requests
        - references
      properties:
        requests:
          type: array
          maxItems: 200
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - original_url
              - version
              - record_version_id
            properties:
              key:
                type: string
                minLength: 1
                maxLength: 4000
              original_url:
                type: string
                minLength: 1
                maxLength: 4000
              version:
                type: string
                minLength: 1
                maxLength: 4000
              record_version_id:
                anyOf:
                  - type: string
                    pattern: ^[a-f0-9]{64}$
                  - type: "null"
        references:
          type: array
          maxItems: 200
          items:
            type: object
    results:
      type: array
      maxItems: 200
      items:
        type: object
output_schema: *a2
evidence:
  - status
  - meetings
failure: Reject missing or changed original-source evidence; retain complete
  source versions and never truncate.
---

Read and compare retained source evidence before any draft or write. This is deterministic preparation, not a completed import.
