---
type: concept
description: Slack wiring for a fictional fixture company with deliberately distinct channel names.
workspace:
  team_id: "TFIXTURE1"
channels:
  board: "CBOARD001"
  builder-test: "CBUILDER1"
---
Channel names come from the convention, never from core code. The fixture uses
`#board` (not `#hq-sprints`, not `#leads`) precisely so a hardcoded channel name
in core would fail the tests.
