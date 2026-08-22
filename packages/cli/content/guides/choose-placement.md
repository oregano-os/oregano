---
document_id: guide.choose-placement
title: Choose the Correct Placement
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

# Choose the Correct Placement

Use this decision order before creating a file:

1. Is it company identity, policy, workflow, knowledge, a connection binding,
   an agent assignment, or a company-specific Tool? Put it in the **Company
   Workspace** at the path defined by the specification.
2. Is it generic execution, validation, schema, SDK, provider integration, or a
   safety invariant shared by multiple companies? Propose it for **Oregano
   Core**.
3. Is it a secret, environment value, deployment binding, or durable runtime
   state? Put it in the **Company Instance**, outside Git where appropriate.

Do not copy Core infrastructure into a Workspace. Do not put company convention
in Core. If a Company Tool may be broadly reusable, implement it safely in the
Workspace first and open a separate graduation decision; reuse is not enough to
move it automatically.
