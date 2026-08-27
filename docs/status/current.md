---
document_id: status.current
title: Current System Status
kind: status
status: approved
authority: canonical
language: en
updated: 2026-08-27
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Current System Status

This page distinguishes implemented Core mechanisms, executable reference
evidence, historical prototypes, and production gaps.

## Implemented and tested

- Real company operating truth lives in a separate Company Workspace. Oregano
  Core contains only generic mechanisms and fictional fixtures.
- Oregano Core has prepared the `0.3.2` initial-development release candidate;
  `v0.3.1` remains the latest stable release until the reviewed candidate is
  merged, tagged, and published. Every Company Workspace advances independently
  under the canonical Versioning Policy.
- `companyos build` combines clean exact Core and Workspace commits with a
  non-secret Instance declaration into one immutable content-addressed
  artifact. The artifact records both product versions, the SHA pair,
  Workspace hash, Capability
  catalog hash, resolved ToolSet hash, roster, scoped agent material, exact
  bindings, and Workbench version.
- A seed provider-neutral Capability catalog, deterministic fail-closed
  ToolSet Resolver, exact Instance binding checks, and runtime Tool-grant
  enforcement are implemented for local Company Tools.
- Company Tool contracts use real JSON Schema enforcement. Their TypeScript
  implementation is statically inspected, compiled, and executed in a
  permission-limited child process that exposes only explicitly granted
  Capability calls. Provider imports, environment access, direct networking,
  dynamic imports, and common sandbox escapes are rejected.
- Workspace and Blueprint inspection include credential-indicator scanning.
  Instance build declarations reject resolved credentials and contain only
  non-secret binding metadata.
- StateStore interfaces and the Neon/Postgres implementation cover append-only
  events, approval requests, authorization, atomic approval consumption,
  idempotent effect claims, dispatch, success, failure, and unknown outcome.
- Canonical principals are surface-neutral. Slack principals remain supported;
  explicit non-Slack principals and agent identities are compiled into the
  artifact. Agent identities cannot approve even if rights are misconfigured.
- The fictional `solstice-homes` reference Workspace and sandbox Instance run
  a property campaign end to end through the same Builder, Tool SDK, Resolver,
  Capability, Connector, approval, effect, and evidence path. Tests cover
  deterministic builds, stale input, self-approval, ungranted Tools, schema
  violations, Connector failure, and unchanged spend ceilings.
- The experimental Workbench implements Guides, Change Plans, Core and
  Workspace inspection, Workspace validation, documentation checks, local
  security checks, onboarding, Package inspection, and Instance artifact
  builds. Its repository release candidate is `0.1.0-experimental.7`; no
  public package release is claimed.
- Codex and Claude Code now share one plugin-free
  `INSTALL-COMPANYOS.md` Release runbook with `BOOTSTRAP_FOR_AGENTS.md` as a
  compatibility entrypoint. `companyos create workspace` supports interactive
  intake and a bounded agent answers-file transport, complete preview,
  confirmed atomic materialization, and a deterministic
  `authoring-only-local` bootstrap checkpoint.
- The experimental `companyos setup --profile vercel-neon-slack` state machine
  continues from that checkpoint through explicit create-or-adopt GitHub,
  Vercel, Neon Marketplace, and Slack Vercel Connect phases. It includes a
  private GitHub repository, automatic best-effort hosted protection with no
  paid-plan requirement, a separately confirmed operating-starter diff,
  required-check and Steward merge evidence, immutable Artifact injection, current
  health verification, and nonce-bound Slack plus Neon persistence proof.
  `companyos verify-live` reports only `live-starter-instance` with readiness
  `validated`.
- Setup and the maintained Runner now select either Vercel AI Gateway or direct
  Anthropic execution. Direct Anthropic bypasses Gateway, requires
  `ANTHROPIC_API_KEY` only as a Sensitive Production runtime variable, and
  fails closed when it is absent. Health, production confirmation, and the
  persisted model-backed Slack response bind the exact route and model without
  storing the secret value.
- The maintained setup implementation now has a private typed four-role
  provider boundary. Its GitHub, Vercel, Neon, and Slack profile records
  write-ahead intents and immutable receipts, verifies the monorepo runner
  root, refuses production-variable conflicts, and separates the fixed Slack
  Agent name `oregano` from Company Workspace identity and provider-internal
  resource names. This is an internal Workbench boundary, not a public provider
  plugin API. Transitive development dependencies used by the pinned Vercel
  CLI are constrained through Vercel-parent-scoped security releases. This
  includes a narrow, audited compatibility override for Vercel's legacy
  HTTP-client dependency without changing another provider or the production
  Runner's direct dependency contract.
- The generated starter contains one supervised `oregano` Agent, one Slack
  workflow, a non-secret Slack connection declaration, and no business Tool
  grants. Its mode-0600 setup state rejects provider credentials, database
  URLs, private keys, Artifact content, and short-lived Slack tokens.
- Contract Foundation Lite recognizes Blueprint, Tool, and Connector Packages
  and implements the manifest schema, Compatibility Registry, local read-only
  Blueprint inspection, declarative file allowlist, credential scanning,
  path hardening, and type-specific Component entrypoint checks.
- The maintained non-Eve Vercel Runner loads one integrity-checked production
  Artifact, admits only active compiled roster humans before model invocation,
  exposes only the resolved ToolSet, and reauthorizes R3/R4 approval clicks in
  Core. Vercel Connect and Chat SDK provide Slack transport; AI SDK and AI
  Gateway provide model turns; the official Anthropic provider supplies direct
  Anthropic model turns when selected; Postgres provides durable chat,
  approval, and effect state.
- A private pilot has exercised the maintained Vercel Runner, Slack transport,
  immutable Artifact loading, and Postgres-backed state. Customer identifiers,
  deployment URLs, immutable revisions, and operating evidence remain in the
  responsible private Company Workspace and development records.
- `artifact.publish` has a real Postgres-backed Instance Connector and serves
  approved artifacts through a restrictive public Vercel route. This proves
  one real Connector path; it does not prove Meta, Monday, or another provider
  effect.
- The experimental proposal-only Builder control path is implemented behind
  explicit Instance configuration. Exact Slack Agent Bindings select Sales,
  Marketing, Builder, or another compiled Agent deterministically before model
  invocation; ambiguous and unknown multi-agent routes fail closed and
  Artifact order is not a fallback.
- Builder conversation uses the maintained normal Runner. Only the
  authenticated requester's explicit confirmation of the objective, repository,
  and exact base creates an idempotent persistent job. Postgres leases,
  asynchronous execution, recovery, timeout, requester cancellation, terminal
  state, and source-thread notification are implemented. Terminal notification
  delivery has its own persistent lease, bounded retry metadata, and backoff;
  it resolves the queued Chat card to a final action-free outcome without
  making terminal execution claimable again. Legacy jobs without a retained
  message identity use a same-thread fallback post.
- Provider-neutral repository-source and checked-proposal contracts have local
  Git and GitHub App implementations. The GitHub profile verifies one selected
  repository, stores no token, handles suspension, uninstall, and repository
  removal, mints separate single-repository read and publication tokens, and
  never passes those credentials to the coding process.
- The isolated Builder worker uses ACP SDK `1.4.0`, Claude Agent ACP `0.70.0`,
  or Codex ACP `1.6.2` as exact dependencies. Unit and local live-login probes
  cover ACP initialization, fresh sessions, structured updates, permission
  denial, timeout, cancellation, bounded writes, and independently observed
  diffs. Protected staged-deployment probes also prove brokered use of both
  general Instance model keys while the coding processes receive placeholders
  rather than the real credentials. Successful fresh sessions now retain
  job-bound input, output, thought, cached-read, cached-write, and total token
  counts plus an explicit reported-or-unavailable provider-cost status. ACP
  remains private Builder-worker transport, not a Core-wide runtime contract.
- The first private `BuilderExecutionAdapter` uses Vercel Sandbox `3.1.0`.
  Live provider probes have proved digest-pinned base execution, deny-all
  egress, no public ports, credential-header transformation, duplicate
  reconciliation, coordinator recovery, timeout, cancellation, collection, and
  cleanup. Detached workers flush one structured result and exit explicitly;
  coordinator output polling is bounded, and an unavailable persisted worker
  marker fails closed. A deliberate live ACP-process `SIGKILL` was recovered
  from the same persisted handle by a replacement coordinator as a terminal
  failure with no diff, followed by Sandbox disposal. A provider-neutral
  in-memory implementation covers conformance and orchestration tests.
- CompanyOS independently rejects protected paths, reconstructs the actual
  transferred diff in a trusted checkout, runs the version-pinned Workbench
  inspection, validation, and security checks, and lets only a trusted outer
  publisher create the canonical branch, commit, and draft proposal. The coding
  agent has no merge or deployment authority. Coding and trusted Git boundaries
  use one canonical adjacent-patch representation, and execution evidence is
  retained when validation and publication evidence are added.

## Reference-only or historical

- The legacy Eve/Slack demo was an accepted walking skeleton, not a generic
  CompanyOS runtime. Its Core-resident adapter and company-specific demo Tools
  have been retired from the active repository.
- The maintained property-campaign proof uses in-process sandbox Connectors
  and fictional state. Sandbox campaign IDs, URLs, spend, conversions, and
  reports prove the control path only; they are not external provider effects.
- The repository-local Blueprint for a property campaign is inspectable and
  authority-free. Applying, locking, updating, or removing a Blueprint Package
  is not implemented; materialization remains an ordinary reviewed Workspace
  diff.

## Approved targets not yet implemented

- Meta, Monday, and other business-provider Connectors are not implemented or
  activated. Each still needs privileged isolation, provenance, SecretRefs,
  health, retry, reconciliation, read-after-write, and conformance evidence.
- Pilot evidence does not establish general production enforcement. Instance
  readiness remains `validated`, not `enforced`, until backup restoration,
  rollback, recovery, alerting, and operator runbooks are exercised and
  recorded for each exact Instance.
- Published Tool Package acquisition and activation remain unsupported even
  though the local Tool SDK, isolation, Resolver, and runtime grant boundary
  now exist.
- Blueprint plan/apply/lock/update/remove, remote Package sources, the open
  Registry, signing, publisher identity, advisories, revocation, and
  Marketplace UX remain future stages.
- The hosted Builder profile is not yet activated in a customer production
  Company Instance. A digest-pinned worker snapshot and the service-owned
  GitHub App exact-base source,
  credential isolation, checked draft publication, and publication idempotency
  gates passed live qualification on 2026-08-26. Protected staged-deployment
  runs also passed brokered Claude Code and Codex authentication using the
  general Instance model keys without placing either real credential in the
  coding process. A second digest-pinned Sandbox snapshot now provides the
  separate trusted Git execution boundary. A protected staged-deployment run
  used the real onboarding handler, reread its Postgres binding, transferred a
  credential-free bundle, passed independent Workbench inspection, validation,
  and security checks, and created the idempotent stacked draft proposal
  `fylingpete/oregano-hq-companyos#4`. On 2026-08-27, an isolated Instance
  Artifact with an exact Slack Builder Agent Binding completed the normal
  Runner, explicit confirmation, Claude ACP, independent validation, and draft
  publication path as `fylingpete/oregano-hq-companyos#6`, with no merge or
  deployment. The job took 298.240 seconds end to end; its coding Sandbox ran
  for 264.182 seconds and used 8.401 active CPU seconds. On the final qualified
  worker snapshot, a separate fixed Claude job recorded 110,033 total tokens
  (10 input, 455 output, 103,466 cached read, and 6,102 cached write) and a
  provider-reported estimated model cost of USD 0.1019435. That is a direct ACP
  receipt from the Anthropic-backed run, not Vercel compute pricing or a billing
  statement. Profiles that do not report a cost record `unavailable` instead
  of a locally inferred price. A second live job injected `SIGKILL` after
  job-bound prompt-start evidence; a replacement coordinator recovered
  `failed`, produced no checked diff, and disposed the Sandbox. A wider
  supervised proposal history remains a production-readiness measurement.

## Highest-priority gaps after the first live pilot

1. Exercise and record database restore, deployment rollback, recovery,
   alerting, and operator runbooks for the exact live Instance.
2. Implement the next approved real business-provider Connector behind the
   existing Capability contracts and pass failure, retry, reconciliation,
   read-after-write, and evidence tests. Meta activation remains a separate
   legal, account, spend, and recovery decision.
3. Establish an isolated non-production Instance and Connector authorization
   instead of testing future changes against production state.
4. Reconcile, validate, tag, and publish the stable immutable `v0.3.2` GitHub
   Release containing the checksum-bound agent runbook. There is no
   `latest-stable` branch; `releases/latest` is discovery only and installation
   pins the exact tag, commit, and Workbench version.
5. Re-qualify the hardened `vercel-neon-slack` setup profile through a fresh
   external end-to-end installation before the next stable release. The prior
   profile completed a real supervised installation and exposed the provider
   receipt, runner-root, Slack-authorization, naming, and health-readiness gaps
   addressed by the current Change Plan; the hardened revision still requires
   its own release qualification.
6. Publish a signed Workbench package so Workspace-only Contributors do not
   require a Core source checkout.
7. Require and qualify hosted repository protection before any future
   unattended agent receives repository write, merge, or deployment authority;
   the maintained supervised starter deliberately grants none of those
   capabilities.
8. Reconcile provider-reported model-cost receipts with provider billing and
   review 10–20 supervised Builder proposals before enabling any customer
   production Builder Agent Binding.

Historical detail remains in archived sources as migration evidence; it does
not override this page or the canonical architecture and specifications.
