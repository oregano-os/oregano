---
type: tool
description: Execute one explicitly bound Brain phase with evidence-only input
  and no autonomous Tool loop.
version: 1.0.0
risk: R0
data_class: business
idempotency: input-hash
capabilities:
  - language.generate
input_schema:
  type: object
  additionalProperties: false
  required:
    - prompt_path
    - data
  properties:
    prompt_path:
      type: string
      minLength: 1
      maxLength: 500
    data:
      type: object
output_schema:
  type: object
  additionalProperties: false
  required:
    - text
  properties:
    text:
      type: string
      minLength: 1
      maxLength: 60000
evidence:
  - text
failure: Reject incomplete or conflicting evidence. No substitute input or
  implicit provider operation.
---

Execute one explicitly bound Brain phase with evidence-only input and no autonomous Tool loop.
