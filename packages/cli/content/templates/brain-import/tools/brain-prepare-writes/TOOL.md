---
type: tool
description: Prepare bounded standard Brain writes from fully verified drafts
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
    - preparation
    - meeting_drafts
    - entity_drafts
    - verification
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
    gate: &a2
      type: object
    preparation: *a2
    meeting_drafts: *a2
    entity_drafts: *a2
    verification: *a2
    procedure:
      type: string
      enum:
        - import
        - reconciliation
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - pages
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
          - changes
          - provenance
          - operation_key
        properties:
          key:
            type: string
            minLength: 1
            maxLength: 512
          changes:
            type: object
            additionalProperties: false
            required:
              - expected_revision
              - pages
            properties:
              expected_revision:
                type: string
                pattern: ^[a-f0-9]{40}$
                description: The immutable repository revision previously read.
              pages:
                type: array
                minItems: 1
                maxItems: 16
                items:
                  type: object
                  additionalProperties: false
                  required:
                    - path
                    - expected_content_hash
                    - markdown
                  properties:
                    path:
                      type: string
                      minLength: 1
                      maxLength: 512
                      description: An ordinary brain/<type-directory>/<slug>.md page, never
                        instructions or configuration.
                    expected_content_hash:
                      type:
                        - string
                        - "null"
                      pattern: ^[a-f0-9]{64}$
                      description: Previously read content_hash, or null for a new absent page.
                    markdown:
                      type: string
                      minLength: 1
                      maxLength: 100000
                      description: Complete valid Markdown replacement with source links.
          provenance:
            type: object
            additionalProperties: false
            required:
              - source_id
              - source_version
              - action
              - evidence
            properties:
              source_id:
                type: string
                minLength: 1
                maxLength: 256
                description: Stable source identity.
              source_version:
                type: string
                minLength: 1
                maxLength: 256
                description: Exact source version.
              action:
                type: string
                minLength: 1
                maxLength: 256
                description: Bounded processing action.
              evidence:
                type: array
                minItems: 1
                maxItems: 16
                items:
                  type: string
                  minLength: 1
                  maxLength: 160
                  description: Canonical internal evidence page slug.
          operation_key:
            type: string
            minLength: 1
            maxLength: 256
            description: Stable source identity + version + processing action. Replay the
              identical input with this key after interruptions; changed input
              needs a new key.
    pages:
      type: array
      maxItems: 200
      items:
        type: object
    source: *a1
    route:
      type: string
      enum:
        - skip
        - reasoning
        - deep
evidence:
  - requests
  - pages
  - source
  - route
failure: Reject incomplete draft verification, stale reads, unresolved write
  receipts and incomplete read-back. Never invent a completed import.
---

Use the standard Brain operations for actual writes and read-back. This deterministic Tool grants no repository authority.
