---
type: workflow
description: One governed shared-thread Friday Close with deterministic completeness and Rollover preparation.
owner: agents/sprint
trigger: the configured business-time close cadence and verified submissions
execution_mode: supervised
goal: Record factual weekly outcomes and next-week proposals while keeping commitment and Rollover authority human.
output: immutable close events, one completeness read model, one retro draft, and an optional approved Rollover effect set
boundary:
  - the frozen participant snapshot is reused for every close step
  - excused absence is accepted only from governed Workspace evidence
  - late classifications use provider-accepted timestamps
  - no performance ranking, inferred reason, or estimated effort is allowed
required_capabilities:
  - records.query
  - work-item.read
  - work-item.update
  - work-item.batch-update
  - communication.message.publish
---
# Friday Close

1. [sprint, R0] Calculate the close business date and all due instants from the validated timezone, calendar, and holiday rule.
2. [sprint, R0] Freeze one versioned participant snapshot and each included participant's committed task set before the reminder.
3. [sprint, R2] Create one shared Close thread at reminder time, referencing the current immutable template; do not republish the full template weekly.
4. [sprint, R0] Validate each submission against the frozen committed tasks and template. Ask one focused correction question when structure or a human fact is missing.
5. [sprint, R2] At the configured chase time, send one neutral consolidated thread reply that mentions each unresolved included participant at most once.
6. [sprint, R0] At report time, freeze exactly one completeness classification. Include accepted submissions up to that instant and exclude later submissions from Friday outputs.
7. [sprint, R2] Publish the short factual completeness check before the retro, with each included participant exactly once and no excused participant listed.
8. [sprint, R1] Prepare the factual retro from recorded actual hours, committed work, open work, human-supplied reasons, and coverage gaps.
9. [sprint, R0] Retain a structurally valid post-report submission only for the next Monday handoff when Workspace policy permits it.
10. [sprint, R0] Freeze one exact batch proposal containing every eligible open work item, its provider version, the allowlisted target field, and the exact target Sprint.
11. [human:sprint-owner] Approve, correct, or reject the complete frozen batch through the ordinary R3 approval path.
12. [sprint, R3] Complete preflight for the entire approved batch before the first write, apply it once, and reread every item. Report conflicts before dispatch and any partial provider outcome as unknown; never substitute or automatically retry a move.

Use the exact reusable assets owned by the `sprint-sop` Skill. The receiving
Workspace may change those assets only through its normal governed review.
