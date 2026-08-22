---
document_id: architecture.validation-inspection
title: Validation and Inspection
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

# Validation and Inspection

CompanyOS deliberately separates deterministic compliance from architecture
judgment.

`companyos validate` is deterministic, LLM-free, non-mutating, and blocking.
It validates document metadata or a Company Workspace and emits the same
diagnostics as human-readable text and structured JSON.

`companyos inspect` produces an Architecture Fitness Report. It discovers
facts about placement, protected paths, documentation impact, and known
anti-patterns, then requires explicit answers for judgments that static code
cannot prove. A required report can be enforced; honest judgment still needs a
human reviewer for protected changes.

```mermaid
flowchart LR
    V["Vision and architecture"] --> I["inspect"]
    S["Specifications and schemas"] --> C["validate"]
    G["Governance"] --> C
    I --> R["Change Report"]
    C --> R
    R --> H["Required human review"]
    H --> D["Merge and deploy"]
```
