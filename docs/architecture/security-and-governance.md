---
document_id: architecture.security-governance
title: Security and Governance
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-20
owners:
  - core-maintainers
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
4. CODEOWNERS and required human reviews,
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

`two_person_review: true` means two people in total: the author and at least one
independent authorized reviewer. It does not mean two additional reviewers.
CODEOWNERS is the GitHub path-to-reviewer mechanism; it normally maps protected
paths to Workspace Steward or Process Steward teams but does not create those
governance roles.

Approval, merge execution, and deployment authorization are different actions.
The required Steward supplies CompanyOS authority, a permitted human or hosted
merge queue performs the mechanical merge after all gates pass, and a Platform
Administrator with `instance` scope authorizes a separately protected
deployment. Merge records an accepted revision; it does not activate that
revision in production.

One self-owned second GitHub account is not an independent reviewer. A sole
Workspace Steward may use the explicitly declared PR-only bootstrap exception
only while `workspace_mode` is `authoring-only`. This preserves pull
requests, CI, and protection against every other Contributor, but it does not
provide separation of duties and is reported as such. An `operating` Workspace
requires the exception to be removed.

Oregano Core uses the same pattern through the machine-readable
[Core Change Policy](../governance/core-change-policy.yaml) and
`companyos inspect-core`. Changes to the Vision, specifications, governance,
validators, state controls, or CI are security-class Core changes.

The hosting-side requirements are operationalized in the
[Repository Protection Guide](../workbench/guides/configure-repository-protection.md).
