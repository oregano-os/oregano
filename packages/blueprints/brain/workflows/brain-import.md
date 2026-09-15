---
type: workflow
id: brain-import
version: 1
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
  - read-correction-pages: oregano:brain/entity
    for_each:
      over: $steps.source-history.requests
      key: key
    input:
      name: $item.slug
  - prepare-correction-records: company:brain-prepare-correction-records
    input:
      prepared: $steps.prepare
      history: $steps.source-history
      reads: $steps.read-correction-pages.items
      source_directory: $config.page_directories.source
  - read-correction-originals: oregano:records/query
    for_each:
      over: $steps.prepare-correction-records.requests
      key: key
    input:
      projection_id: $config.source_projection
      filters:
        identity: $item.identity
        version: $item.version
      source_version_id: $item.record_version_id
  - read-correction-target: oregano:brain/entity
    for_each:
      over: $steps.prepare-correction-records.evidence_reads
      key: key
    input:
      name: $item.slug
  - prepare-correction: company:brain-prepare-correction
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      history: $steps.prepare-correction-records
      results: $steps.read-correction-originals.items
      evidence_reads: $steps.read-correction-target.items
      prompts: $config.prompts.source_reconciliation
      instant: $trigger.instant
  - draft-correction: company:brain-generate
    for_each:
      over: $steps.prepare-correction.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-correction-drafts: company:brain-check-page-drafts
    input:
      requests: $steps.prepare-correction.requests
      results: $steps.draft-correction.items
      route: $steps.prepare-correction.gate.route
  - prepare-correction-verification: company:brain-prepare-correction-verification
    input:
      preparation: $steps.prepare-correction
      drafts: $steps.check-correction-drafts
      prompts: $config.prompts.source_reconciliation_verification
  - verify-correction: company:brain-generate
    for_each:
      over: $steps.prepare-correction-verification.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-correction-verification: company:brain-check-correction-verification
    input:
      requests: $steps.prepare-correction-verification.requests
      results: $steps.verify-correction.items
  - prepare-correction-writes: company:brain-prepare-writes
    input:
      prepared: $steps.prepare
      gate: $steps.prepare-correction.gate
      preparation: $steps.prepare-correction
      meeting_drafts:
        status: drafts-prepared
        pages: []
      entity_drafts: $steps.check-correction-drafts
      verification: $steps.check-correction-verification
      procedure: reconciliation
  - remember-correction: oregano:brain/remember
    for_each:
      over: $steps.prepare-correction-writes.requests
      key: key
    input:
      changes: $item.changes
      provenance: $item.provenance
      operation_key: $item.operation_key
  - check-correction-writes: company:brain-check-writes
    input:
      plan: $steps.prepare-correction-writes
      results: $steps.remember-correction.items
      retained_reads: $steps.prepare-correction-records.pages
  - choose-procedure: route
    on: $steps.prepare.source.kind
    meeting: prepare-normalization
    discussion: prepare-discussion
  - prepare-normalization: company:brain-prepare-normalization
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      prompts: $config.prompts.normalization
  - normalize: company:brain-generate
    for_each:
      over: $steps.prepare-normalization.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-normalization: company:brain-check-normalization
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      results: $steps.normalize.items
  - lookup-entities: oregano:brain/entity
    for_each:
      over: $steps.check-normalization.lookups
      key: key
    input:
      name: $item.name
  - lookup-meetings: oregano:brain/recall
    for_each:
      over: $steps.check-normalization.meeting_searches
      key: key
    input:
      query: $item.query
      type: meeting
      limit: 50
  - check-lookups: company:brain-check-lookups
    input:
      normalization: $steps.check-normalization
      entity_results: $steps.lookup-entities.items
      search_results: $steps.lookup-meetings.items
  - prepare-candidates: company:brain-prepare-candidates
    input:
      lookups: $steps.check-lookups
  - read-candidates: oregano:brain/entity
    for_each:
      over: $steps.prepare-candidates.requests
      key: key
    input:
      name: $item.slug
  - prepare-resolution: company:brain-prepare-resolution
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      normalization: $steps.check-normalization
      lookups: $steps.check-lookups
      candidates: $steps.prepare-candidates
      results: $steps.read-candidates.items
      prompts: $config.prompts.resolution
  - resolve: company:brain-generate
    for_each:
      over: $steps.prepare-resolution.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-resolution: company:brain-check-resolution
    input:
      requests: $steps.prepare-resolution.requests
      results: $steps.resolve.items
  - prepare-source-history: company:brain-prepare-source-history
    input:
      resolution: $steps.check-resolution
      requests: $steps.prepare-resolution.requests
      source_directory: $config.page_directories.source
  - read-source-history: oregano:brain/entity
    for_each:
      over: $steps.prepare-source-history.requests
      key: key
    input:
      name: $item.slug
  - prepare-history-records: company:brain-prepare-history-records
    input:
      prepared: $steps.prepare
      resolution: $steps.check-resolution
      history: $steps.prepare-source-history
      reads: $steps.read-source-history.items
  - read-history-records: oregano:records/query
    for_each:
      over: $steps.prepare-history-records.requests
      key: key
    input:
      projection_id: $config.source_projection
      filters:
        original_url: $item.original_url
        version: $item.version
      source_version_id: $item.record_version_id
  - check-source-history: company:brain-check-source-history
    input:
      prepared: $steps.prepare
      resolution: $steps.check-resolution
      history: $steps.prepare-history-records
      results: $steps.read-history-records.items
  - plan-pages: company:brain-plan-pages
    input:
      prepared: $steps.prepare
      resolution: $steps.check-source-history
      directories: $config.page_directories
  - read-page-targets: oregano:brain/entity
    for_each:
      over: $steps.plan-pages.targets
      key: key
    input:
      name: $item.slug
  - prepare-meeting-pages: company:brain-prepare-meeting-pages
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      plan: $steps.plan-pages
      reads: $steps.read-page-targets.items
      resolution_requests: $steps.prepare-resolution.requests
      prompts: $config.prompts.meeting_page
  - draft-meeting-pages: company:brain-generate
    for_each:
      over: $steps.prepare-meeting-pages.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-meeting-pages: company:brain-check-page-drafts
    input:
      requests: $steps.prepare-meeting-pages.requests
      results: $steps.draft-meeting-pages.items
      route: $steps.gate.route
  - prepare-entity-pages: company:brain-prepare-entity-pages
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      meeting_preparation: $steps.prepare-meeting-pages
      meeting_drafts: $steps.check-meeting-pages
      prompts: $config.prompts.entity_page
  - draft-entity-pages: company:brain-generate
    for_each:
      over: $steps.prepare-entity-pages.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-entity-pages: company:brain-check-page-drafts
    input:
      requests: $steps.prepare-entity-pages.requests
      results: $steps.draft-entity-pages.items
      route: $steps.gate.route
  - prepare-verification: company:brain-prepare-verification
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      meeting_preparation: $steps.prepare-meeting-pages
      meeting_drafts: $steps.check-meeting-pages
      entity_preparation: $steps.prepare-entity-pages
      entity_drafts: $steps.check-entity-pages
      prompts: $config.prompts.verification
  - verify-meetings: company:brain-generate
    for_each:
      over: $steps.prepare-verification.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-verification: company:brain-check-verification
    input:
      requests: $steps.prepare-verification.requests
      results: $steps.verify-meetings.items
      route: $steps.gate.route
  - prepare-writes: company:brain-prepare-writes
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      preparation: $steps.prepare-meeting-pages
      meeting_drafts: $steps.check-meeting-pages
      entity_drafts: $steps.check-entity-pages
      verification: $steps.check-verification
  - remember: oregano:brain/remember
    for_each:
      over: $steps.prepare-writes.requests
      key: key
    input:
      changes: $item.changes
      provenance: $item.provenance
      operation_key: $item.operation_key
  - check-writes: company:brain-check-writes
    input:
      plan: $steps.prepare-writes
      results: $steps.remember.items
      prior: $steps.check-correction-writes
  - readback: oregano:brain/entity
    for_each:
      over: $steps.check-writes.requests
      key: key
    input:
      name: $item.slug
  - finish-import: company:brain-finish-import
    input:
      plan: $steps.check-writes
      reads: $steps.readback.items
    then: end
  - prepare-discussion: company:brain-prepare-discussion
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      prompts: $config.prompts.discussion_extraction
  - extract-discussion: company:brain-generate
    for_each:
      over: $steps.prepare-discussion.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-discussion: company:brain-check-discussion
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      results: $steps.extract-discussion.items
  - lookup-discussion: oregano:brain/entity
    for_each:
      over: $steps.check-discussion.lookups
      key: key
    input:
      name: $item.name
  - plan-discussion: company:brain-plan-discussion
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      extraction: $steps.check-discussion
      reads: $steps.lookup-discussion.items
      directories: $config.page_directories
  - read-discussion-targets: oregano:brain/entity
    for_each:
      over: $steps.plan-discussion.targets
      key: key
    input:
      name: $item.slug
  - prepare-discussion-pages: company:brain-prepare-discussion-pages
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      plan: $steps.plan-discussion
      reads: $steps.read-discussion-targets.items
      prompts: $config.prompts.discussion_entity
  - draft-discussion-pages: company:brain-generate
    for_each:
      over: $steps.prepare-discussion-pages.requests
      key: key
    input:
      prompt_path: $item.prompt_path
      data: $item.data
  - check-discussion-drafts: company:brain-check-page-drafts
    input:
      requests: $steps.prepare-discussion-pages.requests
      results: $steps.draft-discussion-pages.items
      route: $steps.gate.route
  - check-discussion-pages: company:brain-check-discussion-pages
    input:
      prepared: $steps.prepare
      gate: $steps.gate
      preparation: $steps.prepare-discussion-pages
      drafts: $steps.check-discussion-drafts
  - prepare-discussion-writes: company:brain-prepare-writes
    input:
      prepared: $steps.check-discussion-pages.prepared
      gate: $steps.check-discussion-pages.gate
      preparation: $steps.check-discussion-pages.preparation
      meeting_drafts: $steps.check-discussion-pages.meeting_drafts
      entity_drafts: $steps.check-discussion-pages.entity_drafts
      verification: $steps.check-discussion-pages.verification
  - remember-discussion: oregano:brain/remember
    for_each:
      over: $steps.prepare-discussion-writes.requests
      key: key
    input:
      changes: $item.changes
      provenance: $item.provenance
      operation_key: $item.operation_key
  - check-discussion-writes: company:brain-check-writes
    input:
      plan: $steps.prepare-discussion-writes
      results: $steps.remember-discussion.items
      prior: $steps.check-correction-writes
  - readback-discussion: oregano:brain/entity
    for_each:
      over: $steps.check-discussion-writes.requests
      key: key
    input:
      name: $item.slug
  - finish-discussion: company:brain-finish-import
    input:
      plan: $steps.check-discussion-writes
      reads: $steps.readback-discussion.items
---

# Bounded Brain source import

This declarative procedure reads one exact retained source version, retains prior
source and page evidence, and advances through scoped model phases before governed
Markdown commits and indexed read-back. Low-value input remains an explicit
version outcome. Source corrections preserve unrelated knowledge and history.

Materialize the owner and all configuration from reviewed Workspace inputs.
Adoption does not grant Tools, bind providers, admit a source, create a schedule
or activate execution.
