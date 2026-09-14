---
document_id: specification.model-recipes
title: Model recipes and task resolution
kind: specification
status: implemented
authority: canonical
language: en
updated: 2026-09-14
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Model recipes and task resolution

Core owns the provider-neutral model recipe registry and deterministic task
and profile resolution used by Agents, Builder and domain runtimes. This
contract remains version `1.0.0`; removing Knowledge does not remove or change
shared model/provider configuration.

A recipe declares route, transport, credential environment reference and
requirement, default or overridden base URL, model namespace, capabilities,
and advisory defaults. Native recipes use their provider adapters; named
compatible recipes share a common API transport while keeping their
own route, endpoint, credentials and namespace.

The maintained profiles are `agent`, `utility`, `reasoning`, `deep`,
`subagent`, `embedding` and `reranker`. A generic profile name does not install
or grant a capability. `COMPANYOS_MODEL_CONFIG_BASE64` may select an exact task,
a profile or a default recipe/model. Task selection takes precedence over
profile selection, which takes precedence over the configured default.
Explicit configuration takes precedence over legacy `COMPANYOS_MODEL_ROUTE`
and `COMPANYOS_MODEL` selection and key-aware defaults. A resolved request
never silently fails over across providers.

Recipes name credential variables without carrying secret values. Existing
identity, Tool grants, scoped materials and effect approvals remain the
responsibility of their Core layers. Technical smoke tests establish model
readiness, not company authority.

## Scoped generation phases

The trusted `oregano/language-model` prompt binding may declare `model_task`
and `model_profile` together. Supported language profiles are `agent`,
`utility`, `reasoning` and `deep`. The existing resolver applies task, profile
and default precedence. No binding creates a model, provider account or grant.
Bindings without either field retain the owning Agent's explicit model task
and the `agent` profile. Partial bindings, invalid task names and non-language
profiles fail before generation.

Each binding defaults to 16,000 JavaScript string units of instructions. An
explicit `max_instruction_characters` may set a positive integer up to 24,000.
This ceiling supports the measured static Brain phases; it does not qualify
any model's context window. Existing evidence, output and deadline limits do
not change. The Artifact supplies the complete frozen Skill text; referenced
files are never implicitly loaded. Task, profile, capacity and prompt identity
are recorded in binding/prompt digests. Callers and imported evidence cannot
change them.

The experimental [Brain Skill adoption](brain-skill-adoption.md) provides a
static build helper and separately records the remaining model qualification.
It introduces no Brain runtime or replacement for the retired Knowledge system.

Knowledge-only model overrides, maintenance budgets, extraction/synthesis
prompts and their dispatcher have been retired. They have no replacement task
in this contract. See [Prepare an Instance](../workbench/guides/prepare-an-instance.md)
for the maintained generic configuration.

## Native attachments

The selected route/model also resolves its Core attachment policy from
`packages/runner/attachment-policies.json`. Policy data declares supported
model patterns, formats, representations and byte/count budgets separately for
each provider. All Agents use the common preparation and native model adapters;
no Agent-specific file switch or silent provider fallback is introduced.

The first implementation qualifies PDF, PNG/JPEG/WebP and UTF-8 Markdown for
the routes documented in the implementation guide. Markdown is reference text; binary inputs retain
their native representation. The host checks authorized source, metadata and
actual bytes, and the native model boundary checks the combined request on each
step. See [Agent attachments](../operations/agent-attachments.md) for adjustment,
retention, coding-adapter distinctions and context-limit qualifications.
