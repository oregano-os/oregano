---
type: tool
description: Publish one approved campaign asset through the bound artifact Capability.
version: 1.0.0
risk: R3
data_class: business
idempotency: input-hash
capabilities: [artifact.publish]
input_schema:
  type: object
  additionalProperties: false
  required: [artifact_id, content, content_type]
  properties:
    artifact_id: { type: string, minLength: 1 }
    content: { type: string }
    content_type: { type: string, minLength: 1 }
output_schema:
  type: object
  additionalProperties: false
  required: [artifact_id, url, digest]
  properties:
    artifact_id: { type: string }
    url: { type: string }
    digest: { type: string }
evidence: [artifact_id, url, digest]
failure: Return the Connector failure without publishing an alternative.
---
# Publish asset

One approval covers exactly one immutable content payload.
