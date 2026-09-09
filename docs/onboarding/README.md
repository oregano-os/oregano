---
document_id: onboarding.index
title: CompanyOS Onboarding
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-09
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

Instance preparation records non-secret configuration in the Company's
`.companyos/instance.yaml`, directly beside governance and compatibility.
The maintained operating setup includes it before the initial commit or
activation review, and deployment reads that reviewed file. Existing
installations adopt their exact declaration without changing bindings. See
[the format, migration and compatibility rules](../reference/instance-configuration.md).

Start with [Choose a setup](setup-options.md) to distinguish the available
live profile and model variants from local authoring and future provider
combinations. There is currently one implemented infrastructure profile;
the provider-adapter boundary does not make every combination installable.

Onboarding is a maintained product contract, not a one-time setup note. A Human
Contributor or Agent Contributor must be able to enter a Company Workspace,
discover the correct path, establish a deterministic local baseline, and see
which remaining actions require a Platform Administrator with `repository` or
`instance` scope.

For a new installation, Codex and Claude Code use the same release-matched
`INSTALL-COMPANYOS.md` and `companyos setup` session. The CLI reuses account
logins, proposes defaults, asks the company name only when needed, requires an
OpenAI-or-Anthropic choice, and shows
one editable resource/cost/responsibility summary. That single decision covers
new resources and the first production deployment. The human completes actual
provider login and consent. Routine technical work proceeds automatically.

The selected Vercel team must use Pro or Enterprise, detected automatically.
Hobby gets a resumable billing action; Oregano never changes a subscription or
asks about cron frequency. After consent, the fresh initializer generates one
complete operating Workspace and checks its first commit. It does not publish
an authoring-only intermediate version or request an activation PR/merge.
The first ordinary Slack message supplies real model and persistence evidence.
The CLI runs `companyos verify-live` before reporting completion. Slack identity
consent verifies the human; the connector app link opens its Messages tab.
Neither identity consent nor opening Slack proves that Oregano has replied.
Production health uses an alias reported for the exact deployment; protected
deployment URLs do not need to be made public. A healthy application alone does
not prove Slack delivery: setup also checks enabled incoming trigger forwarding
and the exact production attachment before requesting the first message.
An unanswered retry returns [delivery recovery](../workbench/commands/setup.md#slack-delivery-recovery),
including Slack URL verification and saving. Provider synchronization alone
cannot replace a real reply.

Existing Workspaces still use `companyos onboard /path/to/workspace` for local
inspection. `companyos create workspace` and `companyos bootstrap verify` remain
local authoring commands; they are not extra steps in the standard installer.
Only current schema-5 fresh setup sessions can resume. The retired
`setup --profile` flow and schemas 1–4 are unsupported; historical receipts
must not be converted into fresh-installation authority.

The release includes checksummed platform tooling instead of a full developer
installation on the client. This flow is experimental; see the
[five-minute plan](../plans/2026-09-08-five-minute-setup.md) for pending live
qualification and timing criteria.

Core 0.7.0 also supports confirmed Builder releases with advisory repository
protection. After independent checks, the authorized human explicitly confirms
the exact merge and live adoption. Core uses a non-forcing fast-forward on an
unprotected branch and preserves hosted rules on a protected branch. GitHub Free
is sufficient for this path; the Instance still needs qualified repository,
coding and release bindings. See [Operate the Builder](../workbench/guides/operate-builder.md).

The maintained setup profile composes private typed adapters for four roles:
source host, runtime host, state service, and communication provider. GitHub,
Vercel, Neon/Postgres, and Slack are the maintained bindings, not Core runtime
dependencies or a public plugin API. Setup records a non-secret write-ahead
intent before each provider mutation and an immutable resource receipt after
it. A resumed run reconciles an unresolved intent by immutable provider
identity and never creates a second resource from a name-only lookup.

A new Company Instance does not need a database before setup begins. The state
service adapter creates one dedicated PostgreSQL resource and
binds its connection only in the runtime host's secret environment. The next
phase invokes the provider-neutral `companyos database prepare` operation
through that environment. Prepare detects an empty, older, or current database
and selects `bootstrap`, `upgrade`, or read-only `verify`. It creates or
upgrades the `companyos`, `companyos_knowledge`, and `companyos_records`
schemas, records their
immutable schema manifest, and returns a bounded non-secret qualification
receipt. Runtime health and
`companyos database verify` are read-only and fail closed when the prepared
manifest or required schema objects are missing. The maintained Vercel profile
uses `vercel env run`; another runtime profile must provide an equivalent
secret-bound command without making Vercel part of the database contract.
The current manifest is additive `companyos-postgres@1.9.0`: it preserves the
immutable `1.8.0`, `1.7.0`, `1.6.0`, `1.5.0`, `1.4.0`, `1.3.0`, `1.2.0`, `1.1.0`, and `1.0.0` definitions, qualifies 67 required
Knowledge tables and 14 Record Source and Sprint tables, and adds durable Source event, ACL, receipt, watermark,
change-stream, synchronization-lease, lifecycle, compounding-receipt,
Claim-pair-proposal, grading-request, model-result-cache, spend-reservation, and
execution-ledger, Retrieval V3 projection, benchmark, shadow-comparison,
productization-receipt, and atomic Sprint event, state, decision, and intent
records. Unresolved policies and ACL mappings remain
in quarantine. Schema qualification does not authorize retrieval; runtime
subject and policy conformance remain separate gates.

The standard setup asks which provider to use: OpenAI or Anthropic. Neither is
preselected; its exact agent model comes from the maintained recipe. Other
models and providers, including Gateway, require an explicit request and are
not displayed as ordinary choices. Direct recipes bypass AI Gateway and pause while
the human enters a dedicated provider key only in the Vercel project UI under
the documented Sensitive Production variable; setup records only its
reference, presence, and Sensitive classification. Completion
proves the exact route and model through a real model-backed Slack response.

The maintained communication binding always uses the logical Connector UID
`slack/oregano` and the visible Slack Agent name `Oregano`, independently of
the Company Workspace name. Fresh live acceptance requires an ordinary authorized Slack message and a
real model reply, both persisted and correlated to the exact deployment.
Legacy states retain the nonce-bound `Setup-Test` exchange.

An authoring-only Workspace is valid with no operating agents and no executable
workflows. It must not invent automation merely to pass onboarding. The standard initializer produces `operating` directly. Existing authoring
Workspaces use the explicit checked and Steward-confirmed activation change.
Both result in one supervised Oregano Agent, one Slack workflow, one
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

## Builder availability and live adoption

A valid Workspace Builder definition expresses desired availability. The Instance
supplies the actual coding and repository access; a redundant `builder.enabled`
flag is unnecessary. Route conversations with an explicit binding or an authorized
handoff from the normal company Agent. Reading and clarification remain possible
before coding access is ready.

Configure each company's requester or Steward acceptance rules and deployment
delegation in `.companyos/governance.yaml`. Preserve security and independent-review
requirements. A resolved implementation request starts isolated coding without a
second start confirmation. A checked result needs its authorized acceptance before
release; the same human may accept and release in one action when holding both roles.

Use the version-matched [Operate the Builder](../workbench/guides/operate-builder.md)
Guide to bind the shared qualified image, selected coding profile, service App,
repository installation and production executor. One image contains CLI and Guides;
coding and trusted operations use separate executions. Reuse existing production
apps and connections. No Preview or second app is required for simple changes.

The maintained initial release profile combines Workbench checks, protected CI,
human acceptance, staged production health and exact live verification. Other test
strategies and data migrations require qualified evidence/execution before automatic
release. Missing hosted enforcement or provider rights must be reported explicitly;
neither a Workspace declaration nor a passing local test supplies those rights.

## Unpublished installer tests

A maintainer can test a packaged exact commit before publishing a release.
Follow [the candidate setup path](../workbench/commands/setup.md#test-an-unpublished-candidate)
with fresh resources and an automatically named test Slack connector; both agent
harnesses use the same session and one review. Existing company connectors stay
bound to their original deployments.
