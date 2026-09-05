---
type: workflow
id: friday-close
version: 5
owner: agents/sprint
execution_mode: unattended
config: workflows/sprint/config.yaml
trigger: schedule:friday-close-reminder
instance:
  key: sprint_id
  fields: [sprint_id, period_start, period_end, next_sprint_id]
defaults:
  destination: $config.delivery.channel_binding
steps:
  - snapshot-directory: oregano:directory/members
    input: {}
  - participant-roles: oregano:records/query
    input: { projection_id: $config.participants.roles_projection }
    all_pages: true
    require_synced_through: $trigger.instant
  - snapshot-participants: company:participant-view
    input:
      directory: $steps.snapshot-directory
      roles: $steps.participant-roles.rows
      group_id: $config.participants.roster_group
      communication_prefix: $config.participants.communication_prefix
      excluded_ids: $config.participants.excluded_ids
  - snapshot-work-items: oregano:records/query
    input: { projection_id: $config.work_items.projection, filters: { group: $config.work_items.master_group } }
    all_pages: true
    require_synced_through: $trigger.instant
  - open-close-thread: oregano:communications/publish
    template: sprint-sop/friday-update-template.md
    vars: { deadline_time: $config.close.complete_by }
  - await-chase: wait
    for: schedule:friday-close-chase
  - read-submissions-at-chase: oregano:records/query
    input: { projection_id: $config.submissions.projection, filters: { thread_reference: $steps.open-close-thread.thread_reference } }
    all_pages: true
    require_synced_through: $steps.await-chase.instant
  - classify-at-chase: company:close-classification
    input:
      participants: $steps.snapshot-participants.rows
      work_items: $steps.snapshot-work-items.rows
      submissions: $steps.read-submissions-at-chase.rows
      closed_statuses: $config.work_items.closed_statuses
      cutoff: $steps.await-chase.instant
      thread_reference: $steps.open-close-thread.thread_reference
  - chase-route: route
    on: $steps.classify-at-chase.outcome
    incomplete: chase
    complete: await-report
  - chase: oregano:communications/publish
    thread: $steps.open-close-thread.thread_reference
    template: sprint-sop/close-chase-template.md
    vars: { chase_text: $steps.classify-at-chase.chase_text, deadline_time: $config.close.complete_by }
    then: await-report
  - await-report: wait
    for: schedule:friday-close-finalize
  - read-submissions-at-report: oregano:records/query
    input: { projection_id: $config.submissions.projection, filters: { thread_reference: $steps.open-close-thread.thread_reference } }
    all_pages: true
    require_synced_through: $steps.await-report.instant
  - close-view: company:close-classification
    input:
      participants: $steps.snapshot-participants.rows
      work_items: $steps.snapshot-work-items.rows
      submissions: $steps.read-submissions-at-report.rows
      closed_statuses: $config.work_items.closed_statuses
      cutoff: $steps.await-report.instant
      thread_reference: $steps.open-close-thread.thread_reference
  - report: oregano:communications/publish
    thread: $steps.open-close-thread.thread_reference
    template: sprint-sop/friday-completeness-template.md
    vars: { report_text: $steps.close-view.report_text }
  - retro: oregano:communications/publish
    thread: $steps.open-close-thread.thread_reference
    after: report
    template: sprint-sop/retro-template.md
    vars: { report_text: $steps.close-view.report_text, open_items_text: $steps.close-view.open_items_text, effort: $config.effort }
  - prepare-rollover: company:rollover-changes
    input: { open_work_items: $steps.close-view.open_work_items, target_sprint_id: $instance.next_sprint_id }
  - rollover-route: route
    on: $steps.prepare-rollover.outcome
    none: end
    some: approve-rollover
  - approve-rollover: human:sprint-owner
    binds: $steps.prepare-rollover.updates
    via: $config.delivery.decision_binding
    timeout: { business_days: 2 }
    approve: apply-rollover
    reject: end
  - apply-rollover: oregano:work-items/batch-update
    input: { resource_binding: $config.work_items.resource_binding, updates: $steps.approve-rollover.bound }
    then: end
---
# Friday Close

1. [sprint, R0] Freeze the reviewed directory facts for this run. <!-- step:snapshot-directory -->
2. [sprint, R0] Read complete role evidence synchronized through the trigger. <!-- step:participant-roles -->
3. [sprint, R0] Build the participant snapshot using the reviewed group, exact identities, role evidence and exclusions. <!-- step:snapshot-participants -->
4. [sprint, R0] Freeze the committed work items of the Sprint master group. <!-- step:snapshot-work-items -->
5. [sprint, R2] At the reminder time, open one shared Close thread linking the current template and the deadline. <!-- step:open-close-thread -->
6. [sprint, R0] Wait for the chase time. <!-- step:await-chase -->
7. [sprint, R0] Read every submission recorded in the Close thread; require the Slack record source to be synchronized through the chase time. <!-- step:read-submissions-at-chase -->
8. [sprint, R0] Classify every frozen participant as complete, needs-reformat, or missing. <!-- step:classify-at-chase -->
9. [sprint, R0] Continue to the chase only when someone is incomplete. <!-- step:chase-route -->
10. [sprint, R2] Post one chase in the thread naming the incomplete participants. Never a second one. <!-- step:chase -->
11. [sprint, R0] Wait for the report cutoff. <!-- step:await-report -->
12. [sprint, R0] Read the submissions again; require synchronization through the cutoff. A later submission does not change the report. <!-- step:read-submissions-at-report -->
13. [sprint, R0] Classify again at the cutoff and keep the result, including the cutoff instant and the Close thread reference, as this Sprint's close view. <!-- step:close-view -->
14. [sprint, R2] Post the completeness report. Every frozen participant appears exactly once. <!-- step:report -->
15. [sprint, R2] After the report, post the retro draft with the open items. Effort is unavailable, never estimated. <!-- step:retro -->
16. [sprint, R0] Prepare the complete Rollover update set: every open item with its expected version and the target Sprint field. <!-- step:prepare-rollover -->
17. [sprint, R0] End when there is nothing to roll over. <!-- step:rollover-route -->
18. [human:sprint-owner] Decide within two business days whether exactly this update set rolls over. Rejection or timeout ends the close without a write. <!-- step:approve-rollover -->
19. [sprint, R3] Apply the approved update set as one batch: all items are checked before the first write, and a partial result is reported, never hidden. <!-- step:apply-rollover -->
---

<!--
Conventions (resolved by the compiler, never by the model):
- The single key of a step is its id; the value is the Tool. `human:<role>` makes a decision, `route` a route, `wait` a wait on a schedule trigger or a business-day duration.
- `wait` outputs `instant`. Compute steps never read a clock.
- Records rows are passed as they come from `records.query`: `{ record_id, values }`. Company Tools read `values`; the workflow never reshapes rows.
- `all_pages: true` drains the cursor so a snapshot is never one page.
- `require_synced_through: <instant>` fails the step unless the projection's source reports a successful complete synchronization watermark at or after the instant. `fresh_until` (observed time plus allowed age) is not sufficient for a completeness report.
- A message step names `template:` and `vars:`. The compiler renders the template with `vars` and produces the real `oregano:communications/publish` input: `destination_binding` from `destination` or `defaults`, `content` from the rendered template, `thread_reference` from `thread` or `defaults`, `format` from the template frontmatter. `input:` is reserved for Tools called with their own contract; a message step with `input:` is rejected.
- `batch-update` takes `resource_binding` and `updates[]` with `work_item_id`, `expected_version`, `changes`. The decision binds the digest of exactly that `updates` array. An empty set never reaches the Tool: `route` on `outcome` ends first.
- kind, risk, evidence, and idempotency come from the Tool contract and connection; the body marker [owner, Rn] must equal the resolved risk.
-->
