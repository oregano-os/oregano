---
type: workflow
id: weekday-digest
version: 1
owner: agents/sprint
execution_mode: unattended
config: workflows/sprint/config.yaml
trigger: schedule:weekday-activity-digest
instance:
  key: [trigger_id, run_date]
  fields: [trigger_id, run_date, sprint_id]
defaults:
  destination: $config.delivery.channel_binding
steps:
  - changed-items: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { group: $config.work_items.master_group, changed_since: $trigger.previous_instant } }
    all_pages: true
    require_synced_through: $trigger.instant
  - digest-directory: oregano:directory/members
    input: {}
  - digest-roles: oregano:records/query
    input: { projection_id: $config.participants.roles_projection }
    all_pages: true
    require_synced_through: $trigger.instant
  - digest-participants: company:participant-view
    input:
      directory: $steps.digest-directory
      roles: $steps.digest-roles.rows
      group_id: $config.participants.roster_group
      communication_prefix: $config.participants.communication_prefix
      excluded_ids: $config.participants.excluded_ids
  - digest-view: company:monday-handoff-view
    input: { participants: $steps.digest-participants.rows, work_items: $steps.changed-items.rows, empty_message: No changed Sprint items }
  - post-digest: oregano:communications/publish
    template: sprint-sop/weekday-digest-template.md
    vars: { activity: $steps.digest-view.work_items_by_contributor }
  - readiness-route: route
    on: $trigger.params.readiness
    "true": planning-candidates
    "false": end
  - planning-candidates: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { group: $config.work_items.planning_group, status_in: [$config.work_items.planned_status, $config.work_items.ready_status] } }
    all_pages: true
    require_synced_through: $trigger.instant
  - readiness-view: company:readiness-view
    input: { work_items: $steps.planning-candidates.rows, required_fields: $config.work_items.required_fields, ready_status: $config.work_items.ready_status, planned_status: $config.work_items.planned_status }
  - ask-owners: oregano:communications/publish
    for_each: { over: $steps.readiness-view.questions, key: participant_id }
    destination: $config.delivery.direct_binding
    recipient: $item.participant_id
    template: sprint-sop/direct-question-template.md
    vars: { question: $item.question }
  - label-route: route
    on: $steps.readiness-view.outcome
    none: end
    some: approve-labels
  - approve-labels: human:sprint-owner
    binds: $steps.readiness-view.updates
    via: $config.delivery.decision_binding
    timeout: { business_days: 1 }
    approve: apply-labels
    reject: end
  - apply-labels: oregano:work-items/batch-update
    input: { resource_binding: $config.work_items.resource_binding, updates: $steps.approve-labels.bound }
    then: end
---
# Weekday digest

1. [sprint, R0] Read the Sprint items changed since the previous digest trigger, synchronized through now. <!-- step:changed-items -->
2. [sprint, R0] Freeze the reviewed directory facts for this run. <!-- step:digest-directory -->
3. [sprint, R0] Read complete role evidence synchronized through the trigger. <!-- step:digest-roles -->
4. [sprint, R0] Build the participant snapshot using the reviewed group, exact identities, role evidence and exclusions. <!-- step:digest-participants -->
5. [sprint, R0] Reuse the Workspace grouping Tool to render the changed items. <!-- step:digest-view -->
6. [sprint, R2] Post the digest to the Sprint channel. <!-- step:post-digest -->
7. [sprint, R0] Continue to the readiness check only when the trigger declares it for this weekday. <!-- step:readiness-route -->
8. [sprint, R0] Read every planning candidate: items of the planning group in Planned or Ready status, changed or not. <!-- step:planning-candidates -->
9. [sprint, R0] Derive the focused questions for single owners with missing required fields and the readiness label update set. <!-- step:readiness-view -->
10. [sprint, R2] Send each single owner with missing fields one direct question. One question per owner. <!-- step:ask-owners -->
11. [sprint, R0] End when no label changes. <!-- step:label-route -->
12. [human:sprint-owner] Decide within one business day whether exactly this label update set is applied. <!-- step:approve-labels -->
13. [sprint, R3] Apply the approved label updates as one batch with expected versions. Never move an item between groups. <!-- step:apply-labels -->
---

<!--
- `$trigger.params.readiness` is declared on the trigger in schedules/sprint-rhythm.yaml. The scheduler passes params through; it knows nothing about Sprints.
- Planning candidates are read without a change filter, matching the current Core read model. The digest and the readiness check are two separate reads.
- Readiness label changes are an R3 batch write and therefore need a bound Sprint Owner decision. Whether this stays a write or becomes a proposal message is a product decision recorded in the parity matrix.
-->
