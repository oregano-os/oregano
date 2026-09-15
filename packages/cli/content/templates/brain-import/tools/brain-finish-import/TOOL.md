---
type: tool
description: Record a source-version outcome only after complete standard Brain read-back
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - plan
    - reads
  properties:
    plan:
      type: object
      additionalProperties: false
      required:
        - requests
        - receipts
        - source
        - route
      properties:
        requests:
          type: array
          maxItems: 200
          items:
            type: object
            additionalProperties: false
            required:
              - key
              - slug
              - markdown
            properties:
              key: &a1
                type: string
                minLength: 1
                maxLength: 512
              slug: *a1
              markdown:
                type: string
        receipts:
          type: array
          maxItems: 200
          items:
            type: object
        source:
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
        route:
          type: string
          enum:
            - skip
            - reasoning
            - deep
    reads:
      type: array
      maxItems: 200
      items:
        type: object
output_schema:
  type: object
  additionalProperties: false
  required:
    - status
    - source_identity
    - source_version
    - route
    - pages
    - receipts
    - indexed_revision
  properties:
    status:
      type: string
      enum:
        - skipped
        - ingested
        - reconciled
    source_identity: *a1
    source_version: *a1
    route:
      type: string
    pages:
      type: array
      maxItems: 200
      items:
        type: object
    receipts:
      type: array
      maxItems: 200
      items:
        type: object
    indexed_revision:
      type:
        - object
        - "null"
evidence:
  - status
  - source_identity
  - source_version
  - route
  - pages
  - receipts
  - indexed_revision
failure: Reject incomplete draft verification, stale reads, unresolved write
  receipts and incomplete read-back. Never invent a completed import.
---

Use the standard Brain operations for actual writes and read-back. This deterministic Tool grants no repository authority.
