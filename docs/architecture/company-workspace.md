---
document_id: architecture.company-workspace
title: Company Workspace
kind: architecture
status: approved
authority: canonical
language: en
updated: 2026-09-02
owners:
  - oregano-maintainers
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

## Company Knowledge layout

Curated shared knowledge uses OKF v0.1 under `handbook/`. Each searchable file
has `type: concept|playbook|note`, a non-empty `description`, a non-empty body,
and a stable Handbook-relative path. `handbook/index.md` references every OKF
file. Relative links must resolve inside the Handbook. The index and roster are
operational Handbook files and are not searchable OKF in V1.

Raw, unverified material belongs in `brain/inbox/`; review outcomes belong in
`brain/archive/`. Neither directory enters the active Knowledge Bundle.
Promotion is always a reviewed Workspace diff. The V1 knowledge scope is
shared by active roster members, so salary, personnel-file, medical, legally
privileged, or otherwise narrower material is excluded until a later
fine-grained authorization contract exists.

A reviewed `connections/*.md` knowledge-source requirement may declare one
repository document source, data owner, retention, path/size bounds, and
freshness target. Provider identity, ref, scopes, and an `env:NAME` SecretRef
live in the Company Instance binding, not the Workspace. Fetched material
remains a Source Envelope until human review produces and governance accepts an
ordinary OKF Workspace diff.

Retention is either indefinite (`retention: retain`) or finite
(`retention_days: N`). Indefinite retention prevents automatic source-content
purge even after provider deletion; legal hold is a separate temporary control.
The same distinction between durable proof, rebuildable projections, and
temporary coordination state applies across the Company Instance; see
[System of Proof](system-of-proof.md). A Workspace policy cannot override a
valid legal or governed deletion requirement.
