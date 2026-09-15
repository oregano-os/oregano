---
type: tool
description: Validate provisional meeting boundaries and preserve every required
  lookup and uncertainty.
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
    results:
      type: array
      maxItems: 1
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
evidence:
  - status
  - meetings
  - lookups
  - meeting_searches
  - gaps
failure: Reject incomplete evidence or malformed output. No provider access,
  model fallback or knowledge write.
---

Validate provisional meeting boundaries and preserve every required lookup and uncertainty.
