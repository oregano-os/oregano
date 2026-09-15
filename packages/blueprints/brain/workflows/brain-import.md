---
type: workflow
id: brain-import
version: 2
owner: agents/brain-owner
execution_mode: unattended
trigger: operator
config: workflows/brain-import/config.yaml
instance:
  key:
    - source_identity
    - source_version
  fields:
    - source_identity
    - source_version
steps:
  - source-record: oregano:records/query
    input:
      projection_id: $config.source_projection
      filters:
        identity: $instance.source_identity
        version: $instance.source_version
    all_pages: true
  - prepare: company:brain-prepare-source
    input:
      records: $steps.source-record
      identity: $instance.source_identity
      version: $instance.source_version
      segment_characters: $config.segment_characters
  - source-history: company:brain-source-history
    input:
      identity: $steps.prepare.source.identity
      version: $steps.prepare.source.version
      history_from: $config.source_history.from
      cutoff: $trigger.instant
      workflow_id: $config.source_history.workflow_id
  - triage: company:brain-generate
    for_each:
      over: $steps.prepare.segments
      key: key
    input:
      prompt_path: $config.prompts.triage
      data: $item.data
  - gate: company:brain-value-gate
    input:
      expected_segments: $steps.prepare.expected_segments
      results: $steps.triage.items
      source_complete: $steps.prepare.source_complete
      settings: $config.triage
  - agent-context: company:brain-agent-context
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      history: $steps.source-history
      directories: $config.page_directories
  - choose-route: route
    on: $steps.agent-context.route
    skip: finish-skip
    reasoning: process-source
    deep: process-source
  - finish-skip: company:brain-agent-outcome
    input:
      task: $steps.agent-context.task
      route: $steps.agent-context.route
      execution: null
    then: end
  - process-source: agent
    context: $steps.agent-context.task
    instructions: $config.agent.instructions
    skills: $config.agent.skills
    profile: $steps.agent-context.model_profile
    task: brain.ingest
    tools:
      - tool: oregano:brain/recall
      - tool: oregano:brain/entity
      - tool: oregano:records/query
        bind:
          projection_id: $config.source_projection
          filters:
            identity: $instance.source_identity
      - tool: oregano:brain/remember
        bind:
          provenance: $steps.agent-context.provenance
    output_schema:
      type: object
      additionalProperties: false
      required:
        - source_identity
        - source_version
        - status
        - pages
        - meetings
        - verification
        - gaps
      properties:
        source_identity:
          type: string
          minLength: 1
          maxLength: 2000
        source_version:
          type: string
          minLength: 1
          maxLength: 2000
        status:
          enum:
            - ingested
            - reconciled
        pages:
          type: array
          maxItems: 200
          items:
            type: string
            minLength: 1
            maxLength: 2000
        meetings:
          type: array
          maxItems: 30
          items:
            type: object
            additionalProperties: false
            required:
              - slug
              - attendees
              - entities
            properties:
              slug:
                type: string
                minLength: 1
                maxLength: 2000
              attendees:
                type: array
                maxItems: 100
                items:
                  type: string
                  minLength: 1
                  maxLength: 2000
              entities:
                type: array
                maxItems: 100
                items:
                  type: string
                  minLength: 1
                  maxLength: 2000
        verification:
          type: array
          maxItems: 6
          items:
            type: object
            additionalProperties: false
            required:
              - check
              - status
              - detail
            properties:
              check:
                enum:
                  - V1
                  - V2
                  - V3
                  - V4
                  - V5
                  - V6
              status:
                enum:
                  - passed
                  - not-applicable
                  - flagged-uncertainty
              detail:
                type: string
                minLength: 1
                maxLength: 2000
        gaps:
          type: array
          maxItems: 100
          items:
            type: string
            minLength: 1
            maxLength: 2000
    validate: company:brain-check-agent-completion
    budget: $config.agent.budget
  - finish-import: company:brain-agent-outcome
    input:
      task: $steps.agent-context.task
      route: $steps.agent-context.route
      execution: $steps.process-source
---
# Incremental source processing

1. [brain-owner, R0] Source record. <!-- step:source-record -->
2. [brain-owner, R0] Prepare. <!-- step:prepare -->
3. [brain-owner, R0] Source history. <!-- step:source-history -->
4. [brain-owner, R0] Triage. <!-- step:triage -->
5. [brain-owner, R0] Gate. <!-- step:gate -->
6. [brain-owner, R0] Agent context. <!-- step:agent-context -->
7. [brain-owner, R0] Choose route. <!-- step:choose-route -->
8. [brain-owner, R0] Finish skip. <!-- step:finish-skip -->
9. [brain-owner, R1] Understand, read, save meeting knowledge, enrich entities, verify saved pages and correct defects in one continuing Agent task. <!-- step:process-source -->
10. [brain-owner, R0] Record completion only after accepted saved-page verification. <!-- step:finish-import -->
