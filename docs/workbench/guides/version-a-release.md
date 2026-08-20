---
document_id: guide.version-release
title: Version a Release
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - governance.versioning
---

# Version a Release

Use this Guide only for a reviewed release boundary. Ordinary commits do not
each receive a new product version. The
[Core and Workspace Versioning Policy](../../governance/versioning-policy.md)
is authoritative when this Guide and a release decision appear to disagree.

## Select the increment

| Change | Before 1.0 | Example |
|---|---|---|
| Backward-compatible fix, hardening, documentation, CI, or internal refactor with no migration | `PATCH` | `0.1.0` to `0.1.1` |
| Feature or capability, incompatible contract change, migration, or operator decision | `MINOR` | `0.1.4` to `0.2.0` |
| Explicitly approved stability milestone | `1.0.0` | `0.8.4` to `1.0.0` |

Use `alpha.N`, `beta.N`, or `rc.N` only for actual candidates of a named target
release. Never add leading zeroes or a fourth numeric position.

## Apply the release

1. Create and approve a release Change Plan.
2. Change the Core version in the root `package.json` or the Workspace version
   in `company.md`. Advance the two products independently.
3. In a Workspace release, update `.companyos/compatibility.yaml` to the exact
   compatible `core.version`, immutable `core.ref`, and Workbench version.
4. Run `companyos versions`, Validation, Inspection, and the relevant tests.
5. Build from clean exact commits and verify that Artifact and Instance health
   report both product versions and both commits.
6. Merge through repository protection. Create `v<version>` only on the merged
   release commit; never tag a review branch.
7. Record migration and rollback for every minor or major increment.
