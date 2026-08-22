---
document_id: guide.author-agent
title: Author an Agent
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

# Author an Agent

An operating agent lives under `agents/<agent-id>/`. Give it a stable ID,
description, instructions, read/write scope, explicit Tool grants, escalation
route, and evidence obligations. Keep persona in `SOUL.md` where used; keep
authority in machine-readable scope and grants. Persona text never grants
permission.

An `authoring-only` Workspace cannot contain an operating agent. Introduce the
agent, at least one owned workflow, and `workspace_mode: operating` together in
one approved operating-model change so the repository never claims a partial
state.

Start with the smallest scope. Unknown Core capabilities fail closed, and
company-specific grants must resolve to a Tool owned by that agent. Do not give
the agent repository administration, production secrets, or permission to
approve its own protected change.

Adding or widening an agent's behavior or grants is at least a behavior change;
Tool or access changes are security changes.

The [Tool Architecture Specification](../../specifications/tool-architecture.md#5-deterministic-resolution)
shows how the ToolSet Resolver combines catalogs, grants, scopes, policies, and
Instance connections before the runtime registers any Tool.
