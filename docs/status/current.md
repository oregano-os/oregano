---
document_id: status.current
title: Current System Status
kind: status
status: approved
authority: canonical
language: en
updated: 2026-08-23
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
- Oregano Core uses the `0.2.0` initial-development release line. Every Company
  Workspace advances independently under the canonical Versioning Policy.
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
  builds. Its repository release candidate is `0.1.0-experimental.4`; no
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
  Gateway provide model turns; Postgres provides durable chat, approval, and
  effect state.
- A private pilot has exercised the maintained Vercel Runner, Slack transport,
  immutable Artifact loading, and Postgres-backed state. Customer identifiers,
  deployment URLs, immutable revisions, and operating evidence remain in the
  responsible private Company Workspace and development records.
- `artifact.publish` has a real Postgres-backed Instance Connector and serves
  approved artifacts through a restrictive public Vercel route. This proves
  one real Connector path; it does not prove Meta, Monday, or another provider
  effect.

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

## Highest-priority gaps after the first live pilot

1. Exercise and record database restore, deployment rollback, recovery,
   alerting, and operator runbooks for the exact live Instance.
2. Implement the next approved real business-provider Connector behind the
   existing Capability contracts and pass failure, retry, reconciliation,
   read-after-write, and evidence tests. Meta activation remains a separate
   legal, account, spend, and recovery decision.
3. Establish an isolated non-production Instance and Connector authorization
   instead of testing future changes against production state.
4. Reconcile, validate, tag, and publish the next stable immutable GitHub
   Release containing the checksum-bound agent runbook. There is no
   `latest-stable` branch; `releases/latest` is discovery only and installation
   pins the exact tag, commit, and Workbench version.
5. Qualify the new `vercel-neon-slack` setup profile through a real external
   end-to-end installation. Its provider adapters have deterministic and mocked
   tests but have not yet completed that release qualification.
6. Publish a signed Workbench package so Workspace-only Contributors do not
   require a Core source checkout.
7. Require and qualify hosted repository protection before any future
   unattended agent receives repository write, merge, or deployment authority;
   the maintained supervised starter deliberately grants none of those
   capabilities.

Historical detail remains in archived sources as migration evidence; it does
not override this page or the canonical architecture and specifications.
