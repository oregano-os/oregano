---
document_id: guide.author-agent
title: Author an Agent
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-11
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

## Coordinate a shared conversation

Set `conversation_coordinator: true` on the Agent used by an Instance's default
route or exact channel binding. The maintained host asks that Agent to interpret
the incoming message before selecting workflow collection. Keep the policy and
specialist purposes in its Workspace instructions. This flag does not grant
Tools or override the Instance's entry binding.

The coordinator can read small pages of authorized workflow deliveries and
Builder jobs, read one selected context, and submit a checked conversation plan.
A new request can coexist with a waiting collection. Search results are hints,
not execution authority: Core rereads recipient scope and source revision before
dispatch. Descriptive clarification questions retain the original message and
candidate IDs; the Agent interprets natural replies. Routing never supplies an
approving principal or changes a terminal workflow's state.

Declare specialist permissions through the existing `handoffs` list. A concern
handoff executes with the specialist's existing ToolSet and records its rule and
expiry; it does not install an inbox-wide assignment. Use `when_available: true`
only for an explicitly optional Agent (for example a Builder enabled by an
Instance binding). Compilation omits that rule when its target is absent. The
default remains strict: an unavailable non-optional target is an error.

Use a short discussion draft for new multi-step work before a workflow or job
exists. Confirmed Builder jobs replace that reference; the job store retains
its status. "Discuss first; do not create a card" still warrants an internal
discussion reference, which carries no external effect or approval.
Finished drafts can close. Ordinary knowledge questions create no
draft. Company Knowledge search is selected from meaning or by an Agent Tool
call, not a keyword list; successful source evidence is still checked.

The shared runtime uses opaque communication addresses and an injected verified
work source. The maintained chat host retrieves only the current channel's
recipient scope. Another adapter must authenticate its own identity and access
before supplying cross-channel or cross-provider work references. A portable
contract and synthetic tests do not prove a live integration with another communication provider.

## Participate in shared conversations

Use the Core conversation participation contract. An Agent should answer clear
addresses, follow-ups and answers to its own questions, and remain quiet during
human-to-human discussion. Do not instruct it to answer every channel message
or demand an app mention for every thread reply. The existing Agent chooses
participation; do not add a front Agent, attention timer or Workspace imitation
of the Core controller. This choice never grants Tool or approval rights.
