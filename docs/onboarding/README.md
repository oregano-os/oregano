---
document_id: onboarding.index
title: CompanyOS Onboarding
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
relations:
  depends_on:
    - vision.companyos
    - architecture.overview
    - workbench.overview
---

# CompanyOS Onboarding

Onboarding is a maintained product contract, not a one-time setup note. A Human
Contributor or Agent Contributor must be able to enter a Company Workspace,
discover the correct path, establish a deterministic local baseline, and see
which remaining actions require a Platform Administrator with `repository` or
`instance` scope.

For a new Workspace, Codex and Claude Code use the same plugin-free Release
runbook, `INSTALL-COMPANYOS.md`, reached through the compatibility entrypoint
`BOOTSTRAP_FOR_AGENTS.md`. It collects confirmed non-secret answers in chat,
routes them through `companyos create workspace`, and treats
`companyos bootstrap verify` as an internal local checkpoint. The maintained
live path then uses `companyos setup --profile vercel-neon-slack` and finishes
only when `companyos verify-live` proves the narrow supervised starter scope.
The agent waits for the human's browser authentication, provider consent,
hash-bound Steward merge authorization, and production confirmation; it does
not obtain those authorities from the chat prompt.

Start with [Onboard a Company Workspace](company-workspace.md), then run:

```bash
companyos onboard /path/to/company-workspace
companyos bootstrap verify /path/to/company-workspace
companyos setup --profile vercel-neon-slack --workspace /path/to/company-workspace --answers /path/to/live-answers.yaml --state /path/to/setup-state.json --plan
companyos verify-live --state /path/to/setup-state.json
```

The first two commands check the local Workspace contract, immutable Core and
Workbench pin, governance, CODEOWNERS, CI, and the declared
repository-protection baseline. They deliberately report hosted facts as
manual because repository files cannot prove external state. The setup state
machine then attempts hosted protection automatically and records `enforced` or
`advisory` alongside the other provider and runtime evidence without placing
credentials in the Workspace or state file.

The maintained setup profile composes private typed adapters for four roles:
source host, runtime host, state service, and communication provider. GitHub,
Vercel, Neon/Postgres, and Slack are the maintained bindings, not Core runtime
dependencies or a public plugin API. Setup records a non-secret write-ahead
intent before each provider mutation and an immutable resource receipt after
it. A resumed run reconciles an unresolved intent by immutable provider
identity and never creates a second resource from a name-only lookup.

A new Company Instance does not need a database before setup begins. The state
service adapter first creates or explicitly adopts one PostgreSQL resource and
binds its connection only in the runtime host's secret environment. The next
phase invokes the provider-neutral `companyos database prepare` operation
through that environment. Prepare detects an empty, older, or current database
and selects `bootstrap`, `upgrade`, or read-only `verify`. It creates or
upgrades the `companyos` and `companyos_knowledge` schemas, records their
immutable schema manifest, and returns a bounded non-secret qualification
receipt. Runtime health and
`companyos database verify` are read-only and fail closed when the prepared
manifest or required schema objects are missing. The maintained Vercel profile
uses `vercel env run`; another runtime profile must provide an equivalent
secret-bound command without making Vercel part of the database contract.
The current manifest is additive `companyos-postgres@1.5.0`: it preserves the
immutable `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` definitions, qualifies 59 required
Knowledge tables, and adds durable Source event, ACL, receipt, watermark,
change-stream, synchronization-lease, lifecycle, compounding-receipt,
Claim-pair-proposal, and grading-request state. Unresolved policies and ACL mappings remain
in quarantine. Schema qualification does not authorize retrieval; runtime
subject and policy conformance remain separate gates.

Model execution is selected separately as `vercel-ai-gateway`,
`anthropic-direct`, `openai-direct`, or `google-direct`. Gateway needs no
provider key from the human. Direct recipes bypass AI Gateway and pause while
the human enters a dedicated provider key only in the Vercel project UI under
the documented Sensitive Production variable; setup records only its
reference, presence, and Sensitive classification. Completion
proves the exact route and model through a real model-backed Slack response.

The maintained communication binding always uses the logical Connector UID
`slack/oregano` and the visible Slack Agent name `Oregano`, independently of
the Company Workspace name. Live acceptance requires the human's
nonce-bearing Slack message and the exact Agent reply
`Setup-Test <nonce> successful.` in the same conversation, both persisted in
the Instance StateStore.

An authoring-only Workspace is valid with no operating agents and no executable
workflows. It must not invent automation merely to pass onboarding. The live
starter makes the move to `operating` as a separate hash-bound, checked, and
Steward-confirmed change: one supervised Oregano Agent, one Slack workflow, one
non-secret connection declaration, and no business Tool grants.

## Maintenance contract

Any change to required Workspace files, compatibility rules, repository
protection, CI, Workbench commands, Instance preparation, or Contributor entry
points must update these onboarding pages and the `companyos onboard` checks in
the same pull request. `companyos docs check` keeps the published navigation
and bundled Guides synchronized. The required Core Change Plan must list every
affected canonical document explicitly; `companyos inspect-core` fails when a
changed file is outside that plan. These mechanical checks establish coverage
and traceability, while reviewers remain responsible for checking that the
documented behavior matches the implementation rather than merely listing a
document identifier.

## Optional Company Knowledge adoption

New Workspaces contain empty `brain/inbox/` and `brain/archive/` directories.
To adopt Company Knowledge, author indexed OKF in `handbook/`, validate with
`companyos knowledge inspect`, and confirm that all content is suitable for the
shared active-roster scope. Operating adoption builds a separate bundle,
applies `companyos_knowledge` through the existing Neon connection, stages and
verifies the bundle, and activates its exact hash.

After the local corpus is operating, an approved Workspace may declare one
read-only repository knowledge source. Its Instance binding uses an
`env:NAME` SecretRef and `contents:read`; verify it before the first explicit
sync. Synced objects remain raw review envelopes and never bypass the
maximum-three human review queue. Hybrid retrieval requires no external
credential: the default adapter is local, and optional vector-index failure is
reported while lexical retrieval stays available.
