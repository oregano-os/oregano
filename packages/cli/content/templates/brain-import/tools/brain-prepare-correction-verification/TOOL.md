---
type: tool
description: Verify complete proposed corrections against original pages and source versions
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - preparation
    - drafts
    - prompts
  properties:
    preparation: &a1
      type: object
    drafts: *a1
    prompts: *a1
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
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
failure: Stop incomplete original evidence, stale page reads or unchecked source
  correction. Retain completed attempts and effects for explicit continuation.
---

Verify complete proposed corrections against original pages and source versions. Uses existing governed source and page evidence; it grants no provider or Git authority.
