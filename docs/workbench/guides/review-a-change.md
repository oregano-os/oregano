---
document_id: guide.review-change
title: Review a Governed Change
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-22
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Review a Governed Change

First compare the request, Change Plan, and actual diff. Reject understated
change classes, unexpected files, missing documentation impact, or an incorrect
Core/Workspace/Instance placement.

Then review business behavior, denied paths, risk, grants, human authority,
idempotency, evidence, failure handling, migration, and rollback. Run the
version-pinned Workbench checks and relevant tests. A green validator proves
only deterministic conformance; the reviewer still owns architectural and
business judgment.

For a security change, verify that the approving identity is independent of the
author and that the hosting platform actually enforced the required review and
CI checks. Do not rely on approval text added by the author inside the branch.
