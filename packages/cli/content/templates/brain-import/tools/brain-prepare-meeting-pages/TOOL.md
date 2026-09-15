---
type: tool
description: Prepare complete source and read receipts for one meeting page
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
    - resolution_requests
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
    plan:
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
              key: &a6
                type: string
                minLength: 1
                maxLength: 50
              slug: &a7
                type: string
                minLength: 1
                maxLength: 160
              type: &a8
                type: string
                minLength: 1
                maxLength: 40
              name: &a9
                type: string
                minLength: 1
                maxLength: 160
              existing: &a10
                type: boolean
        meetings:
          type: array
          maxItems: 40
          items: &a11
            type: object
        evidence: &a12
          type:
            - object
            - "null"
    reads:
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
    resolution_requests: &a5
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
    requests: *a5
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
          - read
        properties:
          key: *a6
          slug: *a7
          type: *a8
          name: *a9
          existing: *a10
          read: *a11
    evidence: *a12
evidence:
  - requests
  - targets
  - evidence
failure: Reject missing source, changed page reads, incomplete drafts and
  exceeded evidence bounds. No Brain writes occur.
---

Prepare only this phase. A page draft is not an ingested source; entity propagation, semantic verification and actual standard Brain write receipts remain required.
