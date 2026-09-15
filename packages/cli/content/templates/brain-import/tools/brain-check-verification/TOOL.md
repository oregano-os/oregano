---
type: tool
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
description: Require every adopted V1–V6 verdict before downstream Brain writes
input_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - results
    - route
  properties:
    requests:
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
    results:
      type: array
      maxItems: 200
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
    route:
      type: string
      enum:
        - skip
        - reasoning
        - deep
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - reports
  properties:
    status:
      type: string
      enum:
        - triage-skipped
        - verified
    reports:
      type: array
      maxItems: 40
      items:
        type: object
evidence:
  - status
  - reports
failure: Block incomplete or malformed verification and every failed check or
  required repair. A model cannot waive a contradiction or declare a completed
  write.
---

Use the existing owning Workflow and bound verification Skill. A verified draft remains unwritten until standard Brain operations and read-back prove the actual result.
