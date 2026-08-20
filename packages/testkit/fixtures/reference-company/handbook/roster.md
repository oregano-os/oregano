---
type: concept
description: Fictional identities for reference runtime tests.
members:
  - role: steward
    name: Avery
    identities:
      test:
        principal: "test:solstice:avery"
    may_approve: [R1, R2, R3, R4]
    may_see: [business]
  - role: campaign-lead
    name: Morgan
    identities:
      test:
        principal: "test:solstice:morgan"
    may_approve: [R1, R2, R3]
    may_see: [business]
  - role: agent
    name: growth-agent
    type: agent
    identities:
      test:
        principal: "test:solstice:growth-agent"
    may_approve: []
    may_see: [business]
---
# Roster

Only the fictional steward may approve the R4 sandbox campaign launch.
