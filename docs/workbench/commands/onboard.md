---
document_id: command.onboard
title: companyos onboard
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-08-23
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  implements:
    - onboarding.index
    - onboarding.company-workspace
---

# `companyos onboard`

```bash
companyos onboard [workspace] [--format human|json]
```

The command produces one onboarding readiness report. It combines deterministic
Workspace validation, immutable compatibility-pin checks, local governance and
security checks, the declared GitHub repository-protection baseline, and
explicit manual checkpoints for Git-host and Instance-provider accounts.

Checklist states are:

- `complete` — the local deterministic requirement is satisfied;
- `blocked` — a local error must be corrected;
- `manual` — external state cannot be proven locally; the maintained setup may
  establish and record it later, or an accountable administrator may verify it;
- `deferred` — the capability is intentionally absent, such as operating
  automation in an authoring-only Workspace.

The command is read-only. It does not create GitHub protection, identities,
provider accounts, secrets, or Company Instances and never treats a mutable
file as proof that an external control exists. The later maintained setup
attempts hosted GitHub protection automatically and does not require a paid
GitHub plan for the supervised starter.

The maintained provider examples are GitHub for Git hosting, Vercel for runtime
hosting, and Neon/Postgres for durable state. `authoring-only` mode does not require runtime
or state-provider accounts. Equivalent providers remain possible through their
defined architecture boundaries.
