---
document_id: guide.author-company-tool
title: Author a Company Tool
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

# Author a Company Tool

Create `agents/<agent-id>/tools/<tool-id>/TOOL.md` and `execute.ts`. The Tool
document defines purpose, typed input and output, concrete effect, R0–R4 risk,
approval rule, idempotency, evidence, failure semantics, and compensation.

Company Tool code uses only the approved Oregano Tool SDK boundary. It must not
read environment variables, import provider SDKs or Node infrastructure, or
make direct network calls. Secrets and provider bindings belong to the Company
Instance and are exposed only through granted Core capabilities.

Tool creation and grant changes are security-class work. Approval follows the
Workspace's declared `steward` or `independent-review` mode. Run `companyos
validate`, then use `companyos build` with the exact Instance declaration. The
build resolves the grant against the Core Capability catalog, Workspace
allowlist, and exact Connector bindings; file existence and validation alone
are not proof of availability.

See the [ToolSet Resolver flow](../../specifications/tool-architecture.md#5-deterministic-resolution)
for the distinction between declaring a Tool, granting it, resolving it, and
approving a concrete effect.
