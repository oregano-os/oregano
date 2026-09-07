---
document_id: guide.author-agent
title: Author an Agent
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-07
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

## Choose a model task

An Agent may declare `model_task_profile: planning.conversation` in the YAML
frontmatter of its `instructions.md`. This is a logical task name, not a model
name or a secret. The compiler preserves it as `modelTask`; ordinary chat and
workflow-assigned conversations use the same declaration.

The Company Instance maps that task to a model and provider route through its
existing model configuration. Resolution uses the task binding, then the Agent
profile, then the Instance default and existing environment/default rules.
Omitting the declaration preserves existing routing. A malformed declaration
fails compilation. An explicit Agent task takes precedence over automatic
model-task routing; required knowledge Tools and answer checks still apply.

Before human testing, compare the effective model and route with the intended
Instance binding. Retain the selected task and actual response-model evidence.
A declaration alone does not prove which model executed.

## Define good conversations

Put domain-specific quality rules and examples in the Agent's Workspace Skills.
State when to ask a focused question, when to propose wording and which missing
facts must never be invented. A non-empty field is not evidence that its meaning
is correct. Evaluate relevant, incomplete, contradictory and irrelevant replies
with the intended model and compiled instructions. Keep content quality checks
separate from the human approval required for an external change.
