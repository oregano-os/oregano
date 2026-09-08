---
type: tool
description: Build the company participant view from frozen reviewed directory
  facts and explicit role Records.
version: 1.0.0
risk: R0
data_class: personal
idempotency: input-hash
capabilities: []
input_schema:
  type: object
  additionalProperties: false
  required:
    - directory
    - roles
    - group_id
    - communication_prefix
    - excluded_ids
  properties:
    directory:
      type: object
      additionalProperties: false
      required:
        - directory_digest
        - members
      properties:
        directory_digest:
          type: string
          pattern: ^[a-f0-9]{64}$
        members:
          type: array
          maxItems: 1000
          items:
            type: object
            additionalProperties: false
            required:
              - member_id
              - display_name
              - type
              - status
              - group_ids
              - principals
            properties:
              member_id:
                type:
                  - string
                  - "null"
              display_name: &a1
                type: string
              type: *a1
              status: *a1
              group_ids: &a2
                type: array
                items: *a1
              principals: *a2
    roles:
      type: array
      maxItems: 10000
      items:
        type: object
        required:
          - record_id
          - values
        properties:
          record_id: &a3
            type: string
            minLength: 1
          values:
            type: object
            additionalProperties: false
            required:
              - person_ids
              - role
              - lifecycle_state
            properties:
              person_ids: &a4
                type: array
                maxItems: 1000
                items: *a3
              role: *a3
              lifecycle_state: *a3
    group_id: *a3
    communication_prefix:
      type: string
      pattern: ^[a-z][a-z0-9-]*:[^:\s]+:$
    excluded_ids:
      type: array
      maxItems: 1000
      items: *a3
      uniqueItems: true
output_schema:
  type: object
  additionalProperties: false
  required:
    - rows
    - directory_digest
  properties:
    rows:
      type: array
      maxItems: 1000
      items:
        type: object
        additionalProperties: false
        required:
          - record_id
          - values
        properties:
          record_id: *a3
          values:
            type: object
            additionalProperties: false
            required:
              - participant_id
              - display_name
              - included
              - approved_absence
              - communication_principal
              - roles
              - role_record_ids
            properties:
              participant_id: *a3
              display_name: *a3
              included:
                type: boolean
              approved_absence:
                type: boolean
              communication_principal: *a3
              roles: *a4
              role_record_ids:
                type: array
                maxItems: 10000
                items: *a3
    directory_digest:
      type: string
      pattern: ^[a-f0-9]{64}$
evidence:
  - directory_digest
  - rows
failure: Fail on ambiguous identities, missing roles or communication
  principals, and unknown reviewed exclusions.
---
# Participant view

Pure company computation. Operational roles supply evidence, never human
approval authority. Core provides frozen roster facts and normalized Records;
this Tool selects the company cohort and applies its reviewed exclusions.
The initial migration uses an empty exclusion list because the former hosted
snapshot has no approved-absence source. No provider is called.
