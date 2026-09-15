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
explicit `max_instruction_characters` may set a positive integer up to 30,000.
Exceeding the default also requires an explicit phase task/profile pair.
This ceiling supports the measured static Brain phases; it does not qualify
any model's context window. Existing evidence, output and deadline limits do
not change. The Artifact supplies the complete frozen Skill text; referenced
files are never implicitly loaded. Task, profile, capacity and prompt identity
are recorded in binding/prompt digests. Callers and imported evidence cannot
change them.

An explicit phase binding may set `conversation_context: false`. The compiler
retains that exact scoped material for generation but records its path separately
so ordinary conversation prompts do not inline the entire phase library. This
does not revoke scoped access or remove the Agent contract and other materials.
The option requires an explicit task/profile pair and is included in binding
identity. Existing bindings default to their unchanged conversation inclusion.

The experimental [Brain Skill adoption](brain-skill-adoption.md) provides a
static build helper and separately records the remaining model qualification.
It introduces no Brain runtime or replacement for the retired Knowledge system.

Knowledge-only model overrides, maintenance budgets, extraction/synthesis
prompts and their dispatcher have been retired. They have no replacement task
in this contract. See [Prepare an Instance](../workbench/guides/prepare-an-instance.md)
for the maintained generic configuration.

## Scoped generation attempt evidence

The maintained hosted `language.generate` connector records every invocation in
existing control events and effects. A unique attempt binds Instance, run, step,
Agent, Tool, Core/Workspace/Artifact, input/attachment digests and frozen prompt
binding before dispatch. The host validates files and resolves the model, then
awaits the durable dispatch receipt (including the Workflow lease fence when
present) before calling the provider. Failure to persist that boundary prevents
the paid request. Other hosts supply the same StateStore and honor the trusted
`beforeDispatch` callback; it is not part of the model-facing Tool input.

Successful, incomplete and invalid-output calls retain their available usage.
Provider/transport failures retain an unknown outcome, not a made-up empty
response. Input/output, cache components, reasoning tokens and response identity
remain null when unavailable. Reasoning is part of output usage and is not
added again when calculating cost. SDK retries remain disabled; a later explicit
retry is another recorded attempt. Workflow step completion still owns ordinary
resume; the attempt ledger does not silently retry or replace successful steps.

`readLanguageAttempts` reads a bounded explicit run set and reconciles lost
completion events from existing effect receipts. A dispatched attempt with no
receipt stays unknown. Reports fail visibly at the event bound instead of
silently omitting later calls. Receipts contain hashes, identity, usage and
outcome, never prompt/source/answer/reasoning text or raw provider error bodies.

`languageCostReport` accepts actual per-attempt billing receipts or explicit
dated prices for the exact configured route/model. Billed amounts take precedence;
otherwise complete reconciled token/cache quantities permit an estimate. Missing
usage, rates or unresolved outcomes remain unknown rather than zero. Billed and
estimated subtotals stay separate by currency, include failed attempts, and do
not double-count retries or reasoning. Infrastructure attribution and earlier
development costs are separate inputs to the final import report. There is no
new provider, price registry, automatic billing lookup or source of spend authority.

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


Hosted scoped generation appends a generic reminder to follow the reviewed output
contract exactly: JSON-only phases emit the JSON value without wrappers or
commentary; Markdown phases emit the requested document directly. Uncertainty
stays in permitted fields. The host neither strips malformed responses nor
changes semantic validation, source scope, model selection or retry limits.
Before paid dispatch, attempt evidence includes the exact delivered system-prompt digest and character
count, including both host wrapper and reviewed Skill. Prompt measurements use
the same assembly function as the actual request. Existing retained Workflow
Artifacts remain immutable when a compatible host correction is deployed.
