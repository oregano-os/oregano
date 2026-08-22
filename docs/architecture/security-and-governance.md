---
document_id: architecture.security-governance
title: Security and Governance
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Security and Governance

No file can protect itself from a principal that may rewrite the file and
merge directly to the protected branch. CompanyOS therefore uses defense in
depth:

1. non-weakenable safety defaults in Oregano Core,
2. machine-readable Workspace change classes,
3. deterministic validation and diff classification,
4. CODEOWNERS ownership routing and explicit human authorization,
5. Git hosting rulesets and least-privilege tokens,
6. validation of the exact Core/Workspace pair before deployment,
7. provenance and governance hashes in the released Instance.

Workspace policy may tighten Core defaults but never loosen them. Technical
administration and governance authority remain distinct even though both
repository and Instance administration belong to one Platform Administrator
role. Its `repository` and `instance` scopes may be assigned to one person or
separated. Workspace Contributors receive only the repository access required
to propose changes; Agent Contributors and ordinary Human Contributors receive
no administrator, ruleset-bypass, or direct production-branch authority.

Company Workspaces declare one review mode. `review_mode: steward` is the
default and permits one Workspace Steward to approve and merge a protected
change after the required CI check passes. `review_mode: independent-review`
is an optional stricter policy: security changes then use
`two_person_review: true` with an author plus one independent authorized
reviewer. CODEOWNERS maps protected paths to GitHub owners but does not create
CompanyOS governance roles.

Approval, merge execution, and deployment authorization are different actions.
The required Steward supplies CompanyOS authority and explicitly confirms the
checked merge. A permitted human or hosted merge queue performs the mechanical
merge after all gates pass, and a Platform Administrator with `instance` scope
authorizes a separately confirmed deployment. Merge records an accepted
revision; it does not activate that revision in production. Neither Workspace
review mode grants a repository bypass.

Oregano Core uses `review_mode: maintainer`: one accountable Oregano Maintainer
may authorize a checked Core change without a second person or repository
bypass. The machine-readable [Core Change Policy](../governance/core-change-policy.yaml)
and `companyos inspect-core` enforce the plan and authority contract. Changes
to the Vision, specifications, governance, validators, state controls, or CI
are security-class Core changes.

The hosting-side requirements are operationalized in the
[Repository Protection Guide](../workbench/guides/configure-repository-protection.md).
