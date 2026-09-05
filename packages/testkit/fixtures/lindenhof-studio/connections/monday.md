---
type: concept
description: Logical Monday connection serving the Sprint board record source.
provider: monday
resources:
  - id: sprint-board
    permission: read-write
    agent: sprint
api_contract:
  authentication: external-agent
  version: dev
capabilities:
  - records.query
  - work-item.read
  - work-item.batch-update
  - work-item.update
  - work-item.comment
connector_secret_refs:
  agent_id: MONDAY_AGENT_ID
  signing_secret: MONDAY_SIGNING_SECRET
  agent_api_token: MONDAY_API_TOKEN
---
# Monday connection

Monday remains authoritative for work items. Workflows read through Company
Records projections (`records.query`) and write only through
`work-item.batch-update` with an expected provider version and read-after-write
evidence. Exact board identifiers are Instance configuration.
