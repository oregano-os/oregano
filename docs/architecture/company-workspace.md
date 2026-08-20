---
document_id: architecture.company-workspace
title: Company Workspace
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-08-14
owners:
  - core-maintainers
audience:
  - human
  - agent
---

# Company Workspace

A Company Workspace is the company-specific, version-controlled part of
CompanyOS. It lives in one repository owned by the company or its appointed
custodian and remains readable without a proprietary administration UI.

```text
company-workspace/
├── company.md
├── handbook/
├── policies/
├── workflows/
├── agents/
├── schedules/
├── connections/
├── .companyos/
│   ├── compatibility.yaml
│   ├── governance.yaml
│   └── repository-protection.yaml
├── AGENTS.md
├── package.json              # optional in Core-checkout mode
└── pnpm-lock.yaml            # present with a Workspace-local package
```

When present, the root package contains development tooling only: a pinned
CompanyOS Workbench version and scripts. It is not runtime or provider
infrastructure. In Core-checkout mode the compatibility contract supplies the
exact Workbench version without requiring a Workspace-local package.

In co-checkout mode, `.companyos/compatibility.yaml` pins one immutable Core
commit and the exact Workbench version contained by it. The repository
protection contract declares the hosted baseline but cannot itself prove that
GitHub enforces it.

`company.md` declares exactly one `workspace_mode`:

- `authoring-only` contains the Builder Agent entrypoint but no operating
  agents or executable workflows;
- `operating` contains at least one operating agent and one workflow.

A Workspace may begin in `authoring-only`. Moving to `operating` is a governed
operating-model change, not an automatic maturity promotion. It must represent
its state honestly instead of adding placeholder automation merely to satisfy
structure. Each workflow then declares its own `execution_mode`; supervised
and unattended workflows may coexist in one operating Workspace.

Company content may be written in the company's declared working language.
Engineering metadata, schemas, governance, change records, and contributor-facing
instructions remain English.
