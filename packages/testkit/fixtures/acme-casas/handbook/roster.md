---
type: concept
description: Roles and verified identities for a fictional fixture company with deliberately distinct rights.
members:
  - role: founder
    name: Dana
    identities:
      slack:
        team_id: "TFIXTURE1"
        user_id: "UFOUNDER1"
    may_approve: [R1, R2, R3, R4]
    may_see: [business, personal]
  - role: lead
    name: Miguel
    identities:
      slack:
        team_id: "TFIXTURE1"
        user_id: "ULEAD0001"
    may_approve: [R1, R2, R3]
    may_see: [business]
  - role: assistant
    name: Priya
    identities:
      slack:
        team_id: "TFIXTURE1"
        user_id: "UASSIST01"
    may_approve: [R1]
    may_see: [business]
  - role: contractor
    name: Tomas
    identities:
      slack:
        team_id: "TFIXTURE1"
        user_id: "UEXTERN01"
    may_approve: []
    may_see: [business]
    status: inactive
  - role: agent
    name: ops-agent
    type: agent
    identities:
      slack:
        team_id: "TFIXTURE1"
        user_id: "UBOTOPS01"
    may_approve: []
    may_see: [business]
---
Canonical principal: `slack:<team-id>:<user-id>`.

Fixture facts the tests rely on:
- **Dana** is the only R4 approver.
- **Miguel** may approve R3 but not R4 — the "one level short" case.
- **Priya** may approve R1 only — the wrong-user case for R3.
- **Tomas** is `status: inactive` — must never be able to approve anything.
- **ops-agent** is an agent identity: agents never approve.
