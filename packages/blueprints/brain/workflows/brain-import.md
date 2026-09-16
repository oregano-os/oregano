---
type: workflow
id: brain-import
version: 4
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
  - source-record: company:brain-source-records
    input:
      identity: $instance.source_identity
      version: $instance.source_version
      default_projection: $config.source_projection
      routes: $config.source_routes
  - prepare: company:brain-prepare-source
    input:
      records: $steps.source-record.records
      identity: $instance.source_identity
      version: $instance.source_version
      segment_characters: $config.segment_characters
  - ingestion-router: company:brain-ingestion-router
    input:
      source: $steps.prepare.source
      routes: $config.ingestion.routes
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
      processing_instant: $trigger.instant
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
    failure_policy: stop
    context: $steps.agent-context.task
    instructions: $config.agent.instructions
    skills: $config.agent.skills
    instruction_selection: $steps.ingestion-router.instructions
    profile: $steps.agent-context.model_profile
    task: brain.ingest
    tools:
      - tool: oregano:brain/recall
      - tool: oregano:brain/entity
      - tool: oregano:records/query
        bind:
          projection_id: $steps.source-record.projection_id
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
            - skipped
        pages:
          description: "Every affected page.slug, including the source evidence page. Use directory/slug, never brain/ paths, .md suffixes or display names. Read every page after its last write before submitting."
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
                description: "Canonical meeting page.slug from its saved read."
                type: string
                minLength: 1
                maxLength: 2000
              attendees:
                description: "Canonical person page.slug values, never participant display names."
                type: array
                maxItems: 100
                items:
                  type: string
                  minLength: 1
                  maxLength: 2000
              entities:
                description: "Canonical page.slug values for all other affected entities."
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
                description: "Adopted checks: V1 sections; V2 page and Timeline backlinks; V3 speaker resolution; V4 verbatim quotes; V5 attendee evidence; V6 event sequence."
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

1. [brain-owner, R0] Read the exact source from its authorized provider projection. <!-- step:source-record -->
2. [brain-owner, R0] Preserve the complete normalized content and provenance. <!-- step:prepare -->
3. [brain-owner, R0] Select the procedure by content kind, independently of provider. <!-- step:ingestion-router -->
4. [brain-owner, R0] Read earlier processing evidence. <!-- step:source-history -->
5. [brain-owner, R0] Triage the complete source. <!-- step:triage -->
6. [brain-owner, R0] Choose skip, reasoning or deep. <!-- step:gate -->
7. [brain-owner, R0] Prepare one continuing source task. <!-- step:agent-context -->
8. [brain-owner, R0] Choose the model role. <!-- step:choose-route -->
9. [brain-owner, R0] Retain a supported skip. <!-- step:finish-skip -->
10. [brain-owner, R1] Follow the selected Skills: read, write incrementally, verify saved pages and correct defects. <!-- step:process-source -->
11. [brain-owner, R0] Complete only after accepted saved-page verification. <!-- step:finish-import -->
