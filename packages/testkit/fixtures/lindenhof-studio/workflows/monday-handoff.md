---
type: workflow
id: monday-handoff
version: 1
owner: agents/sprint
execution_mode: unattended
config: workflows/sprint/config.yaml
trigger: schedule:monday-sprint-post
instance:
  key: [trigger_id, run_date]
  fields: [trigger_id, run_date, sprint_id, period_start, period_end]
defaults:
  destination: $config.delivery.channel_binding
steps:
  - directory: oregano:directory/members
    input: {}
  - participant-roles: oregano:records/query
    input: { projection_id: $config.participants.roles_projection }
    all_pages: true
    require_synced_through: $trigger.instant
  - participants: company:participant-view
    input:
      directory: $steps.directory
      roles: $steps.participant-roles.rows
      group_id: $config.participants.roster_group
      communication_prefix: $config.participants.communication_prefix
      excluded_ids: $config.participants.excluded_ids
  - current-items: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { group: $config.work_items.master_group } }
    all_pages: true
    require_synced_through: $trigger.instant
  - handoff-view: company:monday-handoff-view
    input: { participants: $steps.participants.rows, work_items: $steps.current-items.rows }
  - post-handoff: oregano:communications/publish
    template: sprint-sop/monday-handoff-template.md
    vars: { period_start: $instance.period_start, period_end: $instance.period_end, work_items_by_contributor: $steps.handoff-view.work_items_by_contributor, participant_count: $steps.handoff-view.participant_count, unique_work_item_count: $steps.handoff-view.unique_work_item_count, unassigned_count: $steps.handoff-view.unassigned_count }
    then: end
---
# Monday handoff

1. [sprint, R0] Freeze the reviewed directory facts for this run. <!-- step:directory -->
2. [sprint, R0] Read complete role evidence synchronized through the trigger. <!-- step:participant-roles -->
3. [sprint, R0] Build the participant snapshot using the reviewed group, exact identities, role evidence and exclusions. <!-- step:participants -->
4. [sprint, R0] Read every current item in Monday's authoritative Sprint master group, synchronized through now. <!-- step:current-items -->
5. [sprint, R0] Group the current items by Contributor. Shared items appear for every included assignee and are marked shared; unmatched items appear under Unassigned. <!-- step:handoff-view -->
6. [sprint, R2] Post the Monday Sprint overview to the Sprint channel. <!-- step:post-handoff -->
---

<!--
- Split from the former sprint-week.md so each schedule trigger has its own workflow and its own instance key [trigger_id, run_date]. Two triggers on the same day can no longer collide, and a redelivered trigger hits the same run.
- This workflow intentionally has no dependency on Friday Close submissions or `NEXT WEEK` plans. Monday's master group is authoritative.
- The Company Tool produces the presentation-ready Markdown block because v1 templates only substitute `{{path}}` values and do not implement loops or grouping.
-->
