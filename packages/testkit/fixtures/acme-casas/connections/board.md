---
type: concept
description: Board connection for a fictional fixture company. The mapping lives here so Core cannot assume column or group identifiers.
provider: board-fake
board_id: "99001122"
groups:
  icebox: "grp_ice"
  ready: "grp_rdy"
  doing: "grp_doing"
  checking: "grp_chk"
  shipped: "grp_ship"
columns:
  status: "color_mkq1"
  owner: "person_a4"
  planned_effort: "numbers_z9"
  outcome: "long_text_77"
  definition_of_done: "long_text_78"
writable_columns:
  - "long_text_77"
  - "long_text_78"
---
Neutral names on the left, provider ids on the right — the engine only ever
speaks the left side. `writable_columns` is the allowlist: a write to any other
column must be refused, which is exactly what the connection tests assert.
