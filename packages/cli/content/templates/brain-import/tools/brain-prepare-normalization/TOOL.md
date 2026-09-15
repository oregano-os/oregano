---
type: tool
description: Prepare complete source evidence for the selected bound meeting
  interpretation route.
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
    - gate
    - prompts
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
    gate:
      type: object
      additionalProperties: false
      required:
        - route
        - items
        - coverage_complete
      properties:
        route: &a4
          type: string
          enum:
            - skip
            - reasoning
            - deep
        coverage_complete:
          const: true
        items:
          type: array
          minItems: 1
          maxItems: 1000
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - classification
              - route
            properties:
              key: &a2
                type: string
                minLength: 1
                maxLength: 500
              classification:
                type: object
                additionalProperties: false
                required:
                  - filing
                  - user_writing_present
                  - user_writing_quality
                  - emotional_significance
                  - business_significance
                  - era
                  - one_line_summary
                properties:
                  filing: *a2
                  user_writing_present:
                    type: boolean
                  user_writing_quality: &a3
                    type: number
                    minimum: 0
                    maximum: 10
                  emotional_significance: *a3
                  business_significance: *a3
                  era:
                    type: string
                    maxLength: 500
                  one_line_summary:
                    type: string
                    minLength: 1
                    maxLength: 2000
              route: *a4
    prompts:
      type: object
      additionalProperties: false
      required:
        - reasoning
        - deep
      properties:
        reasoning:
          type: string
          minLength: 1
          maxLength: 500
        deep:
          type: string
          minLength: 1
          maxLength: 500
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
  properties:
    requests:
      type: array
      maxItems: 1
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
evidence:
  - requests
failure: Reject incomplete evidence or malformed output. No provider access,
  model fallback or knowledge write.
---

Prepare complete source evidence for the selected bound meeting interpretation route.
