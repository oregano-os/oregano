---
type: tool
description: Read exact retained originals for all earlier affected pages
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
    - history
    - reads
    - source_directory
  properties:
    prepared: &a1
      type: object
    history: *a1
    reads: &a3
      type: array
      maxItems: 200
      items: *a1
    source_directory: &a4
      type: string
      minLength: 1
      maxLength: 1000
output_schema:
  type: object
  additionalProperties: false
  required:
    - requests
    - pages
    - evidence_slug
    - evidence_reads
  properties:
    requests:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - identity
          - version
          - record_version_id
          - original_url
        properties:
          key: &a2
            type: string
            minLength: 1
            maxLength: 1000
          identity: *a2
          version: *a2
          record_version_id:
            type: string
            pattern: ^[a-f0-9]{64}$
          original_url: *a2
    pages: *a3
    evidence_slug: *a4
    evidence_reads:
      type: array
      maxItems: 200
      items:
        type: object
        additionalProperties: false
        required:
          - key
          - slug
        properties:
          key: *a2
          slug: *a2
evidence:
  - requests
  - pages
  - evidence_slug
  - evidence_reads
failure: Stop incomplete original evidence, stale page reads or unchecked source
  correction. Retain completed attempts and effects for explicit continuation.
---

Read exact retained originals for all earlier affected pages. Uses existing governed source and page evidence; it grants no provider or Git authority.
