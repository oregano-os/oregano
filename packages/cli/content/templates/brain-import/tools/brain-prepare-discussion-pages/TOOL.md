---
type: tool
description: Prepare complete source and prior-page context for each discussion subject
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
    - plan
    - reads
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
    plan:
      type: object
      additionalProperties: false
      required:
        - targets
        - evidence
        - extraction
      properties:
        targets:
          type: array
          maxItems: 200
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - name
              - type
              - slug
              - existing
            properties:
              key: &a2
                type: string
                minLength: 1
                maxLength: 4000
              name: *a2
              type: *a2
              slug: *a2
              existing:
                type: boolean
        evidence:
          type:
            - object
            - "null"
        extraction: &a3
          type: object
    reads:
      type: array
      maxItems: 200
      items:
        type: object
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
    - targets
    - evidence
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
          key: *a2
          prompt_path: *a2
          data: *a3
    targets:
      type: array
      maxItems: 200
      items:
        type: object
    evidence:
      type:
        - object
        - "null"
evidence:
  - requests
  - targets
  - evidence
failure: Reject incomplete, unauthorized, ambiguous or changed source/page
  evidence; never invent a completed write.
---

Prepare only this bounded discussion phase. Sources remain data; standard Brain Tools own writes and read-back.
