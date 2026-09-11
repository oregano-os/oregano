---
document_id: plan.setup-provider-choice
title: Explicit model provider choice in standard setup
kind: plan
status: approved
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
implementation_scope: provider
providers: [vercel, neon, slack, github, openai, anthropic]
---

# Explicit model provider choice in standard setup

The standard installer must ask which model provider to use, presenting only
OpenAI and Anthropic. Neither is preselected. The selected provider uses its
direct API and existing recipe's agent model. Another supported provider or
model is available only after an explicit request. Vercel AI Gateway remains
an explicit option and a valid existing-session route, never a fresh default.

Keep the single concrete resource/cost decision. The review includes the exact
provider, model, credential destination and provider pricing link. Reuse the
existing Sensitive Production credential-entry action and actual model-backed
Slack verification. Provider selection survives ordinary retries; changing it
before confirmation invalidates the review. An authorized installation retains
its exact provider and cannot silently change route or adopt a key.

Integrate the separately tested setup provider-compatibility fixes and current
main into the existing setup PR, preserving their Slack delivery, identity,
isolated CLI-file and exact production-alias behavior. Do not migrate a running
installation, publish a release, or replace existing test packages.

## Implementation and acceptance

- Reuse the setup adapter and model recipe registries for selection, validation,
  model defaults and credential placement. Reject unsupported/mismatched input
  before resource creation. Show only the two ordinary provider choices.
- Add explicit selection metadata to the release manifest and update the shared
  runbook, onboarding, command and architecture contracts together.
- Exercise both direct providers through the complete synthetic lifecycle,
  including missing credentials, retries, exact deployed model and persistence.
- Cover edits, stale decisions, custom-model requests and an explicitly requested
  Gateway route. Preserve authorized existing Gateway sessions and legacy flows.
- Run setup/release regressions, Core checks, documentation validation and Core
  inspection. New provider-choice live qualification remains separate from the
  successful earlier installer test.

## Placement and reuse

<!-- product-planning-gate:v1 -->

#### Responsibility placement

| Boundary | Responsibility |
|---|---|
| Core | Generic setup selection, validation, review and provider adapters. |
| Packages or Blueprints | Existing recipes and starter templates remain reusable. |
| Company Workspace | Reviewed company identity and operating declarations. |
| Company Instance | Provider credentials, exact model binding and private receipts. |

#### Existing mechanism review

| Mechanism | Decision | Reason |
|---|---|---|
| `model-recipe-resolver` | extend | Expose explicit setup selection using existing recipe defaults and validation. |

All other mechanisms: reuse

#### New Core mechanisms

None.

#### Boundary assertions

- company-values-in-core: false
- secrets-in-git: false
- public-fixtures: synthetic-only
- record-source-delivery: not-applicable
- core-reusability: Any new company chooses a maintained provider through the same setup contract without company-specific code or another runtime resolver.

## Rollback

Revert the selection change for future installations. Preserve exact installed
candidate payloads, private setup decisions and existing provider bindings.

## Validation evidence

The integrated Core `0.7.0` checkout passes the complete project check: 1,055
ordinary tests pass and 50 database opt-in cases are skipped without a test
connection. Documentation validation, publication-boundary checks and Core
inspection pass. The full synthetic standard lifecycle covers OpenAI, Anthropic
and an explicitly requested Gateway for stable and candidate sessions. No live
resources or existing credentials were changed for this implementation. The
separate required database suite runs in GitHub CI; it is not represented by the
ordinary suite's skipped cases.
