---
type: concept
description: Accountable roles and groups of the fictional Lindenhof Studio.
members:
  - role: workspace-steward
    id: mara-steward
    name: Mara Example
    status: active
    may_approve:
      - R1
      - R2
      - R3
      - R4
    identities:
      slack:
        team_id: T10001
        user_id: U10001
      monday:
        principal: monday:300001:1001
  - role: sprint-owner
    id: jonas-owner
    name: Jonas Example
    status: active
    may_approve:
      - R1
      - R2
      - R3
    groups:
      - sprint-participant
      - sprint-process-steward
    identities:
      slack:
        team_id: T10001
        user_id: U10002
      monday:
        principal: monday:300001:1002
  - role: sprint-contributor
    id: lea-contributor
    name: Lea Example
    status: active
    may_approve: []
    groups:
      - sprint-participant
    identities:
      slack:
        team_id: T10001
        user_id: U10003
      monday:
        principal: monday:300001:1003
  - role: sprint-contributor
    id: tim-contributor
    name: Tim Example
    status: active
    may_approve: []
    groups:
      - sprint-participant
    identities:
      slack:
        team_id: T10001
        user_id: U10004
      monday:
        principal: monday:300001:1004
  - role: agent
    id: sprint
    type: agent
    status: active
    may_approve: []
    name: Sprint Coordinator
---
# Roster

Human decision steps in workflows name a **role** (`human:sprint-owner`),
never a person and never a group. Groups (`sprint-participant`) scope record
access; roles carry decision authority. The engine resolves the role to the
active roster members who hold it and accepts a decision only from one of
them, authenticated through the bound surface. Agents can never approve.
