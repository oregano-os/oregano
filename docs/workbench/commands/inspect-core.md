---
document_id: command.inspect-core
title: companyos inspect-core
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-31
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# `companyos inspect-core`

Checks the Core documentation control plane, classifies the actual Git diff
through the Core Change Policy, validates its Core Change Plan, and emits the
required North-Star architecture judgments.

For Change Plan version 2, the report includes the structured
`architecture_assessment`. Inspection therefore makes the declared Core,
Package or Blueprint, Workspace, and Instance split and the existing-mechanism
reuse decisions visible to reviewers. Validation blocks an incomplete catalog,
company values in Core, secrets in Git, non-synthetic Core fixtures, or a
missing cross-company reusability rationale. Human review still decides
whether those declarations are truthful and well designed.

```bash
companyos inspect-core --plan .oregano/changes/my-change.yaml
companyos inspect-core --base origin/main --plan auto
```

The command can enforce evidence and classification. It cannot decide whether
an architecture trade-off is good; that remains an accountable review.

Every document ID in `documentation_impact.affected_documents` must resolve to
a canonical document and that document must be changed in the inspected diff.
The Core Change Policy may also define `documentation_contracts` that bind
implementation paths to a required document set and non-canonical runbooks.
The maintained live-setup contract uses this mechanism so changes to its setup
state machine, provider adapters, database proof, or exact Slack verification
cannot pass inspection without the synchronized onboarding, architecture,
specification, command, status, and installation documentation.
