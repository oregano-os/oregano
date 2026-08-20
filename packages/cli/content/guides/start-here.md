---
document_id: guide.start-here
title: Start Here
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
---

# Start Here

1. Read the Workspace `AGENTS.md` and `company.md`.
2. For a new or newly received Workspace, run `companyos onboard` and follow
   the canonical onboarding checklist.
3. Run `companyos versions` and `companyos validate` before editing to
   establish the exact Core, Workspace, Workbench, and specification baseline.
4. Use the placement rule to decide whether the request belongs in Oregano
   Core, the Company Workspace, or a Company Instance.
5. For behavior or security work, create a Change Plan.
6. Read the object-specific Guide before editing.
7. Run `companyos inspect` and `companyos validate` after editing.
8. Submit a pull request; never push directly to the protected branch.
9. Follow [Version a Release](version-a-release.md) when a release-bearing
   change modifies Core or Workspace behavior.
