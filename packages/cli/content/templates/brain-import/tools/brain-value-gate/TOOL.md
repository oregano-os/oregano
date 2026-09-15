---
type: tool
description: Apply the shared Workspace value gate after every source segment
  has a valid triage result.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - expected_segments
    - results
    - settings
    - source_complete
  properties:
    source_complete:
      const: true
    expected_segments:
      type: array
      minItems: 1
      maxItems: 1000
      uniqueItems: true
      items: &a1
        type: string
        minLength: 1
        maxLength: 500
    results:
      type: array
      minItems: 1
      maxItems: 1000
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
    settings:
      type: object
      additionalProperties: false
      required:
        - filing_categories
        - deep_filing
        - deep_quality_at_least
        - deep_emotional_at_least
        - deep_business_at_least
        - skip_filing
        - skip_scores_below
      properties:
        filing_categories:
          type: array
          items: *a1
          minItems: 1
          maxItems: 20
          uniqueItems: true
        deep_filing:
          type: array
          items: *a1
          minItems: 1
          maxItems: 20
          uniqueItems: true
        deep_quality_at_least: &a2
          type: number
          minimum: 0
          maximum: 10
        deep_emotional_at_least: *a2
        deep_business_at_least: *a2
        skip_filing:
          type: array
          items: *a1
          minItems: 1
          maxItems: 20
          uniqueItems: true
        skip_scores_below: *a2
output_schema:
  type: object
  additionalProperties: false
  required:
    - route
    - items
    - coverage_complete
  properties:
    route: &a3
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
          key: *a1
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
              filing: *a1
              user_writing_present:
                type: boolean
              user_writing_quality: *a2
              emotional_significance: *a2
              business_significance: *a2
              era:
                type: string
                maxLength: 500
              one_line_summary:
                type: string
                minLength: 1
                maxLength: 2000
          route: *a3
evidence:
  - route
  - items
  - coverage_complete
failure: Fail on incomplete coverage, unknown filing values or invalid triage
  JSON. No provider call, fallback classifier or write is performed.
---

Apply the adopted common gate to every selected source, including Slack and meeting transcripts. Deep thresholds are inclusive; skip requires all scores strictly below the threshold and the declared low-value filing. Any retained segment prevents an overall skip. Model task/profile bindings remain fixed by the Workflow; this Tool supplies only its named route.
