---
type: workflow
id: board-hygiene
version: 2
owner: agents/sprint
execution_mode: unattended
config: workflows/sprint/config.yaml
trigger: schedule:board-hygiene-weekly
instance:
  key: [trigger_id, run_date]
  fields: [trigger_id, run_date]
defaults:
  destination: $config.delivery.channel_binding
steps:
  - stale-items: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { group: $config.work_items.master_group, missing_any_of: $config.work_items.required_fields } }
    all_pages: true
    require_synced_through: $trigger.instant
  - triage: company:stale-item-triage
    input: { work_items: $steps.stale-items.rows, planned_status: $config.work_items.planned_status }
  - nudge-owners: oregano:communications/publish
    for_each: { over: $steps.triage.nudges, key: participant_id }
    destination: $config.delivery.direct_binding
    recipient: $item.participant_id
    template: sprint-sop/hygiene-nudge-template.md
    vars: { items: $item.items_text }
  - grace: wait
    for: { business_days: 2 }
    after: nudge-owners
  - recheck: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { work_item_ids: $steps.triage.candidate_ids, missing_any_of: $config.work_items.required_fields } }
    all_pages: true
    require_synced_through: $steps.grace.instant
  - still-stale: company:stale-item-triage
    input: { work_items: $steps.recheck.rows, planned_status: $config.work_items.planned_status }
  - anything-left: route
    on: $steps.still-stale.outcome
    none: end
    some: approve-move
  - approve-move: human:sprint-owner
    binds: $steps.still-stale.updates
    via: $config.delivery.decision_binding
    timeout: { business_days: 2 }
    approve: apply-move
    reject: end
  - apply-move: oregano:work-items/batch-update
    input: { resource_binding: $config.work_items.resource_binding, updates: $steps.approve-move.bound }
    then: end
---
# Board hygiene

1. [sprint, R0] Every week, read the Sprint items that miss a required field, synchronized through now. <!-- step:stale-items -->
2. [sprint, R0] Group them by single owner and prepare the update set that would move ownerless or still-incomplete items back to Planned. <!-- step:triage -->
3. [sprint, R2] Send each owner one direct message listing their incomplete items. <!-- step:nudge-owners -->
4. [sprint, R0] Wait two business days. <!-- step:grace -->
5. [sprint, R0] Read the same items again, synchronized through the end of the grace period. <!-- step:recheck -->
6. [sprint, R0] Recompute what is still incomplete. <!-- step:still-stale -->
7. [sprint, R0] End when nothing is left. <!-- step:anything-left -->
8. [human:sprint-owner] Decide whether exactly this update set moves back to Planned. Rejection or timeout ends the run without a write. <!-- step:approve-move -->
9. [sprint, R3] Apply the approved update set as one batch. <!-- step:apply-move -->
---

<!--
Second v1 example. Existing Capabilities only, no cycles, compact form. Adds
one construct use: `wait` on a business-day duration.
-->
