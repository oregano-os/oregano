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
    task: $steps.agent-context.model_task
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
    completion: text
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
11. [brain-owner, R0] Retain the final Agent report and actual write receipts. <!-- step:finish-import -->
