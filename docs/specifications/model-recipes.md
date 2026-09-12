---
document_id: specification.model-recipes
title: Model recipes and task resolution
kind: specification
status: implemented
authority: canonical
language: en
updated: 2026-09-11
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

Knowledge-only model overrides, maintenance budgets, extraction/synthesis
prompts and their dispatcher have been retired. They have no replacement task
in this contract. See [Prepare an Instance](../workbench/guides/prepare-an-instance.md)
for the maintained generic configuration.
