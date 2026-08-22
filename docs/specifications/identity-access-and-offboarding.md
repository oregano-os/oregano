---
document_id: specification.identity-access-offboarding
title: Identity, Access, and Offboarding Specification
kind: specification
status: building
authority: normative
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - specification.companyos-core-v0.7
    - governance.roles
---

# Identity, Access, and Offboarding Specification

This is the controlled English successor to the German identity supplement.
It preserves the approved identity mechanics while replacing the ambiguous
legal-owner label with explicit operational roles. It remains `building` until
the remaining continuity policy and Sprint-path tests are approved.

## 1. Borrowed authentication, CompanyOS authorization

CompanyOS does not maintain passwords or a parallel user-account system.
External systems authenticate people through their own MFA, SSO, sessions, and
device controls. CompanyOS authorizes the resulting verified principal through
the Workspace roster and policy.

Provider membership is a perimeter, not authority. A person who can enter a
channel or repository does not thereby gain permission to read every data class,
approve an effect, alter policy, or deploy an Instance.

## 2. Stable principals and roster records

`handbook/roster.md` is the Workspace source for role assignment and stable
external identity anchors. Display names are not security identifiers. A
canonical provider principal includes its tenant boundary, for example:

```text
slack:<team-id>:<user-id>
github:<organization-or-enterprise>:<login>
```

A roster member contains at least:

- stable member ID or canonical provider identity;
- display name and operational role;
- identity type (`human`, `external`, or `agent`);
- active or inactive status;
- allowed approval levels;
- allowed data classes;
- expiry for temporary external access where applicable.

Every R3/R4 approver MUST have a resolvable verified provider identity. Agent
identities MUST have no approval rights. Inactive identities MUST be denied even
if stale rights remain in their record.

## 3. Authentication and authorization checkpoints

| Access path | Authentication perimeter | CompanyOS authorization |
|---|---|---|
| Approval interaction | provider login and signed interaction | active roster identity, role, risk, exact action, expiry, single use |
| Agent conversation | channel or application identity | active roster identity and allowed data class before model access |
| External-system event | verified webhook/provider actor | declared connection mapping and workflow trigger authority |
| Workspace change | Git identity | governance class, CODEOWNERS, required review, and CI |
| Instance administration | platform identity | Platform Administrator role and provider policy |
| Database access | Instance service identity | least-privilege database role; agents do not receive direct credentials |

Every connection declares how its actor field maps to a canonical roster
principal. Unmapped identities fail closed. The actor written to evidence is the
stable principal, never only a display name.

## 4. Approval surface and exact-action binding

The current Stage 1 Instance uses Slack as its sole effect-approval surface.
Monday or other systems may trigger work but do not grant approval. This is an
Instance decision, not a universal requirement that every future CompanyOS
deployment use Slack.

The Core control layer extracts the signed provider actor before handing control
to the replaceable runtime. An approval binds the actor, role, action, payload
hash, risk, expiry, and single-use state. A changed source object or payload
invalidates the request and requires a new approval. Rejected and unauthorized
attempts are evidence and MUST leave the legitimate approval path usable.

## 5. Onboarding

1. A relevant administrator provisions the external provider account.
2. A security-class Workspace change adds the stable identities, role, data
   classes, approval limits, and optional expiry to the roster.
3. The appropriate Workspace Steward reviews the change through the protected
   repository process.
4. Provider channels and resources are granted only after roster authority is
   active and only to the required scope.

An agent MAY prepare the diff but cannot approve or merge its own access grant.

## 6. Offboarding

Offboarding is triggered by departure, contract expiry, loss of role, or
suspected compromise. Compromise uses the same order but begins immediately:

1. disable the external authentication account and revoke active tokens;
2. remove repository and provider-resource access;
3. set the roster record to inactive, record the date, and remove all rights;
4. expire open approvals and reassign open work;
5. verify removal from private resources;
6. start applicable retention or deletion periods for personal data.

Historical roster records MUST NOT be deleted because approvals, events, and
decisions must remain attributable. Deactivation removes authority; retention
policy governs personal data separately.

## 7. Special cases and continuity

- A role change is an access migration with the same protected review.
- Agent offboarding revokes bot/provider identities and marks the roster entry
  inactive.
- Temporary External Human Contributor access MUST expire and MUST exclude repository-admin,
  production-secret, and ruleset-bypass permissions.
- Every Company Instance requiring R4 continuity SHOULD have at least two
  independently authenticated eligible human roles. The final assignment is a
  protected decision in each Company Workspace.

## 8. Required tests

- wrong actor is denied and cannot close the valid approval;
- inactive human is structurally denied despite stale rights;
- agent identity is structurally denied despite an erroneous grant;
- same provider user ID in another tenant is denied;
- changed action input invalidates the approval;
- simultaneous approval attempts produce exactly one consumed action;
- offboarded identity can neither initiate authorized work nor approve it.
