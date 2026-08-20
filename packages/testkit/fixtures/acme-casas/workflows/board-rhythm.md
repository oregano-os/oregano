---
type: workflow
description: A fictional board rhythm with values chosen to expose hardcoded company assumptions.
owner: agents/ops
trigger: board webhook (item moved / field changed) or schedule
input: board item id
execution_mode: supervised
goal: Keep the fixture board complete and moving without assuming a real company's process.
boundary:
  - never writes a column outside the connection allowlist
  - never approves its own effects
verified_by: fixture events and the test adapter outbox
---
# Board rhythm (fixture workflow)

1. [ops, R0] Read the item and mirror it (neutral model: group, owner,
   planned effort, outcome, definition of done).
2. [ops, R1] If `outcome` or `definition_of_done` is empty while the item sits
   in `doing`, open a briefing thread — one question per message.
3. [ops, R2] Write answers back into the **writable** columns only
   (`connections/board.md` decides which; anything else must be refused).
4. [human:lead] Review the requested status write-back; the agent effect that
   follows needs an R3 approval click — per
   `policies/risk-levels.md` rule 2 this company treats it as R3.
5. [ops, R0] Silence per `agents/ops/skills/board-sop.md`
   (**72** working hours, **2** escalations) → then raise an issue item.
6. [ops, R1] Bundle movement posts every **30** minutes into `#board`,
   never during quiet hours (**20:00–07:00**).

Every number in this file or the SOP frontmatter is a parameter — the engine
reads it, it never hardcodes it.
