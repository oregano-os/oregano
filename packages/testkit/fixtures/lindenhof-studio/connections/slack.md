---
type: concept
description: Logical Slack connection. Exact channel and team identifiers live in the Company Instance.
provider: slack
approved_surfaces:
  - channel-app-mention
  - subscribed-thread
  - one-to-one-direct-message
destinations:
  - id: studio-sprints
    kind: channel
    visibility: private
    agent: sprint
  - id: sprint-direct
    kind: dynamic-direct-message
    visibility: private
    agent: sprint
  - id: finance-direct
    kind: dynamic-direct-message
    visibility: private
    agent: finance
capabilities:
  - communication.message.publish
connector_secret_ref: SLACK_CONNECTOR
---
# Slack connection

Workflows refer to destinations by id only (`studio-sprints`,
`sprint-direct`). The Instance binds each id to one exact channel or to a
verified participant principal. `sprint-direct` and `finance-direct` are
templates whose recipient must come from a roster principal; they are not
wildcard audiences.
