---
document_id: plan.builder-acp-mvp-implementation
title: Builder ACP MVP Architecture and Delivery Plan
kind: plan
status: approved
authority: informative
language: en
updated: 2026-08-26
owners:
  - oregano-maintainers
audience:
  - human
  - agent
relations:
  depends_on:
    - vision.companyos
    - reference.glossary
    - architecture.oregano-core
    - architecture.company-workspace
    - architecture.company-instance
    - specification.builder-governance
    - specification.companyos-core-v0.7
    - governance.agent-agreement
---

# Builder ACP MVP Architecture and Delivery Plan

## Implementation status on 2026-08-26

The proposal-only MVP described here is now implemented on the isolated
`codex/builder-acp-stage-0` branch. Deterministic Agent resolution, explicit
Builder confirmation, persistent jobs and leases, cancellation, the portable
worker, private ACP profiles, repository contracts, local Git and GitHub App
providers, independent Workbench validation, trusted outer publication, and
source-thread terminal reporting have automated coverage.

The worker snapshot was created successfully as
`snap_j4cFUC1EmFNuEn422dGxP4xXMaUw` from the pinned base image. It contains ACP
SDK `1.4.0`, Claude Agent ACP `0.70.0`, and Codex ACP `1.6.2`.

The implementation is intentionally not activated in Production. Remaining
deployment gates are:

1. run the brokered Claude Code and Codex gates inside a target deployment
   where Vercel exposes the two Sensitive general model variables at runtime;
2. install and qualify the service-owned GitHub App against one real private
   Company Workspace;
3. bind the snapshot, cron secret, GitHub provider, Agent routes, and updated
   immutable Artifact in an isolated non-production Instance; and
4. complete one Slack-to-draft-proposal round trip with no merge or deployment.

Vercel Sensitive values are deliberately non-readable after creation. A local
qualification MUST NOT import every unrelated Production secret merely to
obtain the two model keys. Run the model gates in an isolated deployment or
explicitly approve a narrowly reviewed alternative.

## 1. Purpose and approved decisions

This plan delivers the first proposal-only Builder Agent and multi-agent
routing path for CompanyOS. The Builder remains a governed Company Agent, uses
the normal Runner for request intake and clarification, and delegates one
confirmed Workspace-change job to an isolated coding agent.

The accountable owner accepted these directions on 2026-08-26:

| Decision | Approved direction |
|---|---|
| Company Agent selection | A deterministic `AgentResolver` evaluates explicit Agent Bindings. It does not classify message intent with a model. |
| Builder presentation | The Builder is a separately addressable Company Agent and may be bound to a dedicated Slack channel. |
| Builder conversation | Intake, clarification, and confirmation use the existing normal `RunnerAdapter`. |
| Builder start | A confirmed `builder.propose_change` operation creates a persistent Builder job. Merely routing a message to the Builder does not start a coding agent. |
| Coding-agent protocol | Stable ACP v1 is the private execution protocol of the Builder worker. It is not a CompanyOS Core, Runner, Tool, approval, or governance contract. |
| Coding-agent implementations | Claude Code and Codex are the first allowlisted, exactly versioned ACP profiles. |
| Runtime abstraction | The MVP does not introduce a general `AgentRuntimeAdapter`. It implements one concrete `BuilderAcpClient` for coding-agent communication and one narrow private `BuilderExecutionAdapter` for execution-host lifecycle. |
| Execution host | The Company Instance binds a qualified Builder execution provider. Vercel Sandbox is the first maintained adapter, not a Core or Workspace dependency. |
| Repository boundary | Provider-neutral `RepositorySourceAdapter` and `ProposalPublisher` contracts separate exact-base source materialization from checked proposal publication. Repository credentials never enter the coding-agent process. |
| GitHub self-service | The hosted GitHub provider uses one installable CompanyOS GitHub App per service environment. Customers install that same App on an account or organization and select repositories; they never create an App or copy tokens. |
| GitHub token lifecycle | The trusted GitHub provider mints a new repository- and permission-scoped installation token for source access and, only after validation, a separate token for proposal publication. Tokens are never Workspace configuration or Builder inputs. |
| Execution boundary | Coding agents run in an isolated, time-bounded worker and never inside the synchronous Slack request path. |
| Authority | The Builder creates proposals only. CompanyOS validates the actual diff; humans retain merge and deployment authority. |

## 2. Product outcome

An authorized CompanyOS member can address the Builder in a bound surface,
clarify a desired Company Workspace change, explicitly start a proposal, and
receive a validated branch or pull request with attributable evidence. The
same Builder control path can use Claude Code or Codex without changing the
normal CompanyOS Runner.

The intended path is:

```text
inbound Slack message
  -> verify principal
  -> resolve Company Agent
  -> Builder conversation through the normal Runner
  -> explicit proposal confirmation
  -> persistent Builder job
  -> exact source materialization through the bound Repository Source provider
  -> isolated worktree and worker
  -> ACP v1 coding-agent run
  -> inspect the actual diff outside the coding agent
  -> Workbench and CI validation
  -> checked proposal publication through the bound Proposal Publisher
  -> human review, merge, and deployment decision
```

## 3. System boundaries

### 3.1 AgentResolver

The `AgentResolver` selects one compiled Company Agent from trusted routing
facts such as communication surface, account or tenant, and exact channel. Its
rules are named Agent Bindings.

The MVP resolver supports:

1. exact Slack team and channel bindings;
2. thread inheritance from the bound parent conversation; and
3. one explicitly configured default Agent.

When a multi-agent Instance has neither a matching binding nor an explicit
default, resolution fails closed. Artifact order is never an authorization or
routing rule. Content-based or model-based intent routing is outside MVP scope.

### 3.2 Company Agents

Sales, Marketing, Oregano, and Builder remain Company Agents with separate
instructions, scoped materials, resolved ToolSets, and conversation state.
Agent selection does not expand an Agent's data or Tool grants.

The Builder entrypoint remains `agents/builder/instructions.md`. It defines the
durable Builder Agent; it is not a per-change Change Plan. Each confirmed job
creates a distinct Change Plan bound to its requested objective and base
revision.

### 3.3 Normal RunnerAdapter

The existing `RunnerAdapter` handles all normal Company Agent conversations,
including Builder intake and clarification. ACP does not replace this adapter
and is not used for ordinary Sales, Marketing, or Oregano turns.

### 3.4 Builder request operation

The Builder exposes one controlled request operation, initially named
`builder.propose_change`. A surface action or explicit authorized Tool call
submits the operation after the human has reviewed the objective and intended
scope.

The request records at least:

- stable requester principal;
- Company Instance and Workspace identity;
- objective and source conversation;
- exact base commit;
- request and idempotency identifiers; and
- requested proposal timing where policy permits it.

Submitting a request is not merge, deployment, policy-change, or effect
authority.

### 3.5 BuilderService

The `BuilderService` owns CompanyOS domain orchestration:

- requester and policy validation;
- Builder job creation and state transitions;
- base-revision pinning;
- selection of the qualified Instance coding-agent profile and execution-host
  binding;
- worktree and sandbox preparation;
- worker admission, timeout, and cancellation;
- post-run diff inspection and governance classification;
- Workbench validation and evidence assembly; and
- proposal publication through a separately controlled Git identity.

ACP does not define any of these CompanyOS semantics.

### 3.6 Builder worker and sandbox

The Vercel Runner remains the communication plane. It persists and reports the
job but does not host a long-running coding-agent process in the Slack request.
An asynchronous Builder worker runs each job in an ephemeral execution
environment.

The execution environment is reached through a private
`BuilderExecutionAdapter`. This adapter abstracts only the provider-specific
worker lifecycle: start a qualified job, observe status, request cancellation,
collect the result, and dispose the environment. It does not select Company
Agents, interpret ACP, grant Tools, approve changes, or publish proposals.
Vercel Sandbox is the first maintained implementation. A future Docker,
Kubernetes, Hetzner, Railway, or other worker provider must pass the same
conformance suite and can replace it without changing Builder domain behavior.

Each job receives:

- a fresh temporary worktree at an exact base commit;
- bounded writable paths;
- CPU, memory, duration, and process limits;
- controlled network access;
- no Slack, production database, deployment, or repository-administration
  credentials;
- a dedicated, budget-limited coding-model credential or qualified native
  authentication binding; and
- deterministic termination and cleanup.

The sandbox and post-run checks are security boundaries. ACP permissions and
agent instructions are not security boundaries.

### 3.7 BuilderAcpClient

The `BuilderAcpClient` is a concrete stable-ACP-v1 client private to the Builder
worker. Its MVP responsibilities are limited to:

- launch one allowlisted ACP agent process;
- complete ACP initialization and capability negotiation;
- create one fresh session per Builder job;
- send the prepared prompt and context;
- receive structured session and tool updates;
- answer permission requests through a fail-closed host policy;
- propagate timeout and cancellation;
- classify process and protocol failures; and
- record the exact selected implementation and non-secret runtime evidence.

Persistent coding sessions, ACP v2, dynamic registry discovery, arbitrary
Workspace-provided commands, and automatic runtime fallback are outside MVP
scope.

### 3.8 Qualified ACP profiles

The Company Instance selects one explicit coding-agent profile independently
from its execution-adapter binding. The first supported coding-agent profiles
are:

- Claude Code through an exactly pinned `claude-agent-acp` implementation that
  delegates to the Claude Agent SDK; and
- Codex through an exactly pinned `codex-acp` implementation that delegates to
  the Codex App Server.

The Workspace may express that a Builder capability is required, but it cannot
select an arbitrary executable, package source, version, model credential, or
sandbox policy. Those bindings belong to the Company Instance.

A conceptual non-secret Instance declaration is:

```yaml
builder:
  execution_mode: proposal-only
  execution:
    adapter: vercel-sandbox
    profile: isolated-v1
  coding_agent:
    protocol: acp-v1
    profile: claude-code
```

Changing either binding is an explicit Instance configuration and qualification
decision. The model never chooses the execution provider or chooses between
Claude Code and Codex during a job. These axes are independent: the same Claude
ACP profile can run through another qualified execution adapter, and the same
Vercel Sandbox adapter can host either qualified ACP profile.

### 3.9 Repository source and self-service provider binding

The Core reaches version-control systems through a provider-neutral
`RepositorySourceAdapter`. It asks the bound Company Instance provider to
materialize one repository at one exact base commit and return non-secret source
evidence. The contract does not expose GitHub Apps, OAuth, personal access
tokens, SSH keys, Vercel, or provider SDK types. A local provider may use an
existing checkout without remote authentication; GitLab, Bitbucket, a private
mirror, or another repository host may implement the same contract.

For the hosted GitHub self-service path, one installable CompanyOS GitHub App
is created per service environment, with Production and Staging separated. The
App is created once by the service operator, not once per customer or
repository. During onboarding the customer:

1. selects GitHub as the Repository Provider;
2. installs the CompanyOS GitHub App on a personal account or organization;
3. selects only the repositories CompanyOS may access; and
4. reviews and grants the declared proposal-only permissions.

The authenticated onboarding callback verifies the installation and selected
repository through GitHub before storing a non-secret binding from the Company
Instance to the installation and repository identities. Installation changes,
suspension, and removal are reconciled from verified provider events. The App
identity and private key are service-environment secrets; installation and
repository identifiers are Instance state; none belong to the Company
Workspace or immutable Artifact.

For source materialization, the trusted GitHub provider mints an installation
token narrowed to the selected repository and `contents: read`, uses it only to
obtain the exact base revision, and revokes or discards it before the coding
agent starts. The agent receives a clean local worktree, never the token,
remote credential helper, App private key, or GitHub API capability.

The GitHub App is a provider implementation, not a CompanyOS contract. A
self-hosted Instance may bind a separately operated GitHub App, a different
repository provider, or `LocalGitRepositorySourceAdapter`. The Builder flow and
governance remain unchanged.

### 3.10 Workbench validation and proposal publication

After the ACP process finishes, CompanyOS independently reads the worktree and
classifies the actual diff. It then invokes the same versioned Workbench
implementation used by humans and CI for Change Plan validation, Workspace
validation, architecture inspection, documentation checks, and security
preflight.

Only a trusted `ProposalPublisher` may publish a checked branch and pull
request. It is a separate provider-neutral capability from source
materialization. For GitHub, the provider mints a fresh installation token
narrowed to the selected repository and the minimum `contents` and pull-request
write permissions only after every local gate passes. It creates the canonical
commit, branch, and pull request outside the coding-agent process and then
revokes or discards the token.

The coding agent receives no Git-host credential and its own commits, remotes,
or publication claims are not trusted. A successful coding-agent result is not
evidence that a change is valid, published, merged, or deployed.

### 3.11 Planned repository placement

The Core implementation is split by responsibility rather than by provider:

- the current `packages/companyos-builder/` is renamed to an unambiguous
  Artifact component after the active overlapping Core work is complete; it
  compiles Agent Bindings into the immutable Artifact and never hosts a coding
  agent;
- `packages/runtime/agent-resolver.ts` and `packages/runtime/builder/` own
  provider-neutral Agent resolution, Builder jobs, `BuilderService`,
  `BuilderExecutionAdapter`, `BuilderAcpClient`, and qualified ACP profile
  definitions;
- `packages/builder-worker/` owns the portable isolated worker entrypoint and
  contains the exact ACP, Claude Code, and Codex dependencies used in its
  qualified image or snapshot;
- `packages/runtime/repository/` owns the provider-neutral
  `RepositorySourceAdapter`, source receipt, and `ProposalPublisher` contracts;
- `packages/connectors/` owns maintained repository-provider implementations,
  beginning with GitHub installation verification, exact-source
  materialization, token brokering, and proposal publication;
- `packages/runner-vercel/src/lib/builder/` owns the first Vercel Sandbox
  adapter, provider SDK, sandbox policy translation, and provider receipt
  mapping for the maintained pilot;
- `packages/state-store/` owns Builder job and lease interfaces, while
  `packages/state-postgres/` owns the maintained durable implementation and
  migrations, including verified repository-installation bindings;
- `packages/runner-vercel/src/lib/` wires Slack intake and status presentation
  to the provider-neutral Builder service but contains no ACP semantics;
- `packages/testkit/` owns an in-memory execution-adapter fake, shared adapter
  conformance tests, routing fixtures, and Builder failure-path tests; and
- `packages/cli/` owns Workbench commands for qualification, inspection,
  cancellation, recovery, and diagnostics where those commands are required.

The second execution-provider implementation is the extraction trigger
for a dedicated provider package. Until then, the compact placement avoids
top-level package proliferation while the neutral interface and conformance
suite preserve replaceability. The exact filenames may be refined by the
approved Core Change Plan, but the dependency direction is fixed: provider
adapters depend on provider-neutral Builder contracts; Core, Workspace
artifacts, and ACP profiles never import a provider SDK.

`oregano-development` remains private research and publication-review context.
It may receive a private change-history record or follow-up evidence, but it is
not the source of the public implementation or canonical architecture. All
generic code and canonical documentation land in `oregano`.

## 4. End-to-end Builder flow

1. Slack authenticates the sender and supplies stable channel facts.
2. CompanyOS verifies the canonical roster principal before model invocation.
3. `AgentResolver` resolves the message to the Builder Agent.
4. The normal Runner conducts clarification with the Builder instructions and
   scoped material.
5. The human explicitly confirms a proposal request.
6. `builder.propose_change` creates an idempotent persistent Builder job.
7. `BuilderService` validates the request and records the exact base commit.
8. The bound `RepositorySourceAdapter` materializes the exact source revision
   without exposing its credential to the coding-agent environment.
9. The worker creates a fresh restricted sandbox around the local worktree.
10. `BuilderAcpClient` starts the configured, pinned ACP profile.
11. Claude Code or Codex performs one fresh coding-agent session and changes
    only the local worktree.
12. CompanyOS terminates the runtime and independently reads the actual diff.
13. Workbench and CI checks validate scope, plan, documentation, and security.
14. The bound `ProposalPublisher` creates the canonical commit, branch, and
    pull request only after local gates pass.
15. The source Slack thread receives status, evidence summary, and proposal
    link.
16. Authorized humans decide merge and deployment through existing governance.

## 5. MVP non-goals

- Replacing the normal Runner with ACP.
- Using ACP for ordinary Sales, Marketing, or Oregano conversations.
- A general or public `AgentRuntimeAdapter` contract.
- Dynamic installation or execution from the ACP Registry.
- ACP v2 or unstable ACP extensions.
- Model- or content-based Company Agent routing.
- Automatic Claude-to-Codex failover or replay after side effects may exist.
- Long-lived coding-agent sessions across Builder jobs.
- Coding-agent access to production providers or secrets.
- Repository-provider credentials inside the coding-agent environment.
- A GitHub App, OAuth flow, token format, or repository-provider SDK as a Core,
  Workspace, Builder-job, or ACP contract.
- Builder self-approval, auto-merge, or automatic deployment.
- Builder changes to Oregano Core, Instance infrastructure, repository
  protection, runtime state, or approval evidence.

## 6. Delivery stages

### Stage 0: qualify the ACP decision — 2 to 3 engineering days

Run one identical bounded Workspace fixture through Claude Code and Codex. Both
profiles must demonstrate:

- non-interactive or explicitly brokered authentication;
- exact implementation and version evidence;
- ACP v1 initialization and a fresh session;
- structured progress and tool updates;
- permission denial and fail-closed behavior;
- cancellation and timeout;
- writes contained to the mounted worktree;
- model authentication through the selected sandbox credential boundary without
  exposing the real provider credential to the coding-agent process;
- deterministic process shutdown; and
- an independently readable resulting diff.

The repository boundary is qualified independently of ACP. A shared
`RepositorySourceAdapter` conformance path must prove exact-base
materialization, idempotency, non-secret receipts, credential absence during
agent execution, and failure after installation revocation. The GitHub live
profile must use the service-owned App installation flow; a customer-supplied
App private key or manually copied long-lived token does not close this gate.

Failure of one profile does not authorize a silent native fallback. The
qualification report identifies the unsupported profile and the smallest
separate decision required to proceed.

### Stage 1: update architecture and specifications — 2 to 3 engineering days

- create the Core Change Plan for behavior and security changes;
- specify Agent Bindings and deterministic Agent resolution;
- specify the asynchronous Builder job and worker boundary;
- specify Repository Provider bindings, `RepositorySourceAdapter`,
  `ProposalPublisher`, and the GitHub self-service installation lifecycle;
- define ACP v1 as a private Builder execution protocol;
- define profile qualification, version pinning, and failure behavior;
- update `docs/architecture/overview.md` with the complete message-to-proposal
  flow diagram;
- update `docs/architecture/oregano-core.md` and
  `docs/architecture/system-boundaries.md` with ownership and dependency
  boundaries for Agent resolution, Builder orchestration, ACP, and execution
  providers;
- update `docs/architecture/company-instance.md` with a diagram that separates
  the Runner binding, Builder execution-adapter binding, and ACP coding-agent
  profile from Repository Source and Proposal Publisher bindings;
- update `docs/specifications/builder-governance.md`, the applicable Core and
  Workspace specifications, and `docs/glossary.md` with the normative contracts
  and terminology;
- update onboarding and Workbench documentation with configuration,
  qualification, operation, cancellation, recovery, and proposal-review
  procedures;
- update `docs/status/current.md` and the compatibility registry with only the
  support actually proved by tests; and
- regenerate and validate the documentation registry and navigation artifacts.

Architecture visuals are maintained as Mermaid source inside the canonical
Markdown documents so they remain reviewable and change with the contracts.
Static images are added only where a real UI or provider screen cannot be
explained accurately by a diagram. Documentation and visuals are part of each
implementation stage's acceptance criteria, not a follow-up after coding.

### Stage 2: implement AgentResolver — 4 to 6 engineering days

- add compiled Agent Bindings to the immutable Artifact;
- resolve an Agent for every accepted inbound message;
- preserve thread routing;
- require an explicit default in multi-agent deployments;
- remove artifact-order fallback for multi-agent traffic; and
- test Sales, Marketing, Builder, default, unknown, and ambiguous routes.

### Stage 3: activate Builder conversation intake — 4 to 6 engineering days

- compile the Builder as an addressable Company Agent when the Instance
  enables the capability;
- register the bounded Builder request operation;
- add explicit Slack confirmation presentation;
- persist idempotent Builder jobs and status transitions; and
- post progress and terminal outcomes to the source thread.

### Stage 4: implement source materialization, worker, and sandbox — 7 to 11 engineering days

- define the minimal provider-neutral `RepositorySourceAdapter` contract and
  shared conformance tests;
- implement `LocalGitRepositorySourceAdapter` for local/self-hosted operation;
- implement the hosted GitHub installation callback, verified binding, event
  reconciliation, and exact-base source adapter behind the same contract;
- define the minimal private `BuilderExecutionAdapter` lifecycle and shared
  conformance tests;
- implement and qualify Vercel Sandbox as the first maintained adapter;
- implement job claim, lease, retry, cancellation, and cleanup;
- create exact-base worktrees from source receipts;
- enforce file, process, duration, resource, network, and credential limits;
- separate coding-agent credentials from Git proposal credentials; and
- prove that worker failure leaves no partial published branch effect.

### Stage 5: implement BuilderAcpClient — 7 to 10 engineering days

- use stable ACP v1 through an exactly pinned TypeScript dependency;
- implement process lifecycle and capability negotiation;
- implement the minimal session, prompt, update, permission, and cancel path;
- add qualified Claude Code and Codex launch profiles;
- normalize only the evidence CompanyOS needs; and
- run the shared conformance suite against both profiles.

`acpx` may accelerate Stage 0 because it already provides headless ACP sessions
and structured output. Production code must either use the official ACP SDK
directly or pin and qualify the exact imported `acpx/runtime` surface. It must
not execute floating `npx ...@latest` commands.

### Stage 6: implement the governed change loop — 6 to 9 engineering days

- prepare the coding prompt from the confirmed request and exact Workspace
  state;
- create and validate the per-job Change Plan;
- inspect the actual diff outside the coding agent;
- enforce protected-path and change-class rules;
- invoke Workspace, documentation, architecture, and security checks;
- produce deterministic failed and blocked outcomes; and
- assemble complete non-secret evidence.

### Stage 7: publish the proposal — 6 to 9 engineering days

- define the provider-neutral `ProposalPublisher` contract and shared
  conformance tests;
- create the canonical branch, commit, and pull request through a trusted outer
  publisher rather than through the coding-agent worktree;
- implement GitHub publication through the verified CompanyOS App installation
  with a newly minted, single-repository, least-privilege token;
- keep source-read and proposal-write capabilities separate even when one
  GitHub installation backs both;
- generate the pull request description from checked evidence;
- preserve CODEOWNERS, protected-branch, and CI enforcement; and
- send the checked proposal link and result to the source conversation.

### Stage 8: harden and prepare the pilot — 5 to 8 engineering days

Test at least:

- prompt injection from Workspace material;
- traversal, symlink, rename, and protected-path writes;
- credential and environment exfiltration attempts;
- unauthorized network access;
- fabricated or malformed ACP events;
- runtime crash, hang, cancellation, and cleanup;
- duplicate job delivery and stale leases;
- ACP adapter and coding-runtime version drift;
- Claude and Codex capability differences; and
- incomplete, understated, or contradictory Change Plan evidence.

## 7. Delivery estimate and sequencing

For one engineer, the expected delivery range is:

- ACP and AgentResolver technical prototype: 2 to 3 weeks;
- complete proposal-only MVP with GitHub self-service: 8 to 11 weeks; and
- supervised pilot of 10 to 20 real proposals: a further 2 to 4 calendar
  weeks.

Agent routing and Builder worker work can proceed partly in parallel after
Stage 0 and the approved Core Change Plan. With two effective contributors,
the MVP may compress to approximately 5 to 7 weeks, subject to the worker host
and credential design.

## 8. Technical uncertainties to close first

### 8.1 Worker and sandbox host — provisional resolution

Bind the worker host through the private `BuilderExecutionAdapter` owned by the
Company Instance. Configure Vercel Sandbox as the first maintained pilot
implementation, not as a Builder, Core, Workspace, ACP, or job-schema
dependency. Keep the existing Vercel Runner as the reference communication and
control plane, and use the maintained Postgres store as the reference durable
Builder job ledger. Replacing any of these reference providers must not change
the Builder domain flow.

The MVP has no runtime registry, dynamic provider discovery, or generic agent
platform. One explicit Instance binding selects one allowlisted execution
adapter. The small adapter contract covers only `start`, `status`, `cancel`,
`collect`, and `dispose`, with provider-neutral job and evidence records.

The MVP topology is deliberately small:

1. The confirmed Builder operation inserts one idempotent job and returns.
2. A coordinator claims the job with a bounded lease and asks the bound
   execution adapter for one fresh, non-persistent environment with a hard
   timeout and no public ports.
3. The bound `RepositorySourceAdapter` materializes the exact base revision.
   Any provider credential remains inside the trusted source provider and is
   revoked or discarded before the coding agent starts.
4. The Sandbox network policy then permits only the selected model endpoint and
   the narrow CompanyOS result path. The real model credential is injected by
   the external request proxy or credential broker and is not stored in the
   Sandbox environment.
5. The pinned ACP worker and pinned Claude or Codex profile run in the isolated
   worktree and produce a diff plus structured evidence.
6. The coordinator retrieves the result and stops the Sandbox in all terminal
   paths. CompanyOS runs post-diff checks outside the coding-agent process.
7. Only the bound `ProposalPublisher` may obtain a new provider write
   credential after the diff passes all gates.

The first `vercel-sandbox` adapter is preferred because the provider is
purpose-built for untrusted and AI-generated code, uses isolated microVMs,
supports OCI images, bounded lifetimes, network egress policies, and credential
brokering, and fits the maintained Vercel reference stack. A pinned OCI image
or qualified snapshot also makes the ACP worker and Workbench toolchain
reproducible without creating a separately operated worker platform.

A future `docker`, `kubernetes`, `hetzner-worker`, or other adapter may host the
same pinned worker bundle and ACP profiles after passing the shared isolation,
lifecycle, evidence, and credential conformance tests. Provider-specific SDK
types, resource IDs, and credentials stay inside the adapter and Instance
receipts.

GitHub Actions remains useful for ordinary CI after a proposal is published,
but it is not the pilot coding-agent host. Code running inside an Actions job
can access the job's `GITHUB_TOKEN` and every secret deliberately supplied to
that job. A coding agent that edits and executes repository code therefore
creates an avoidable credential-exposure boundary even on a fresh hosted
runner. Separating untrusted execution from proposal publication is simpler to
reason about and test.

This decision remains provisional until Stage 0 proves four details:

- the pinned Claude and Codex ACP profiles work with brokered authentication
  while the real provider credential remains outside the Sandbox;
- the provider-neutral repository-source conformance suite and hosted GitHub
  self-service profile materialize an exact private revision while App and
  installation credentials remain absent during agent execution;
- the result path, cleanup, timeout, and cancellation behavior are reliable
  under process crashes and duplicate delivery; and
- measured duration and compute cost are acceptable for representative Builder
  jobs.

The first Stage-0 execution probe on 2026-08-26 proved the neutral five-method
adapter lifecycle against Vercel Sandbox SDK `3.1.0`. A real disposable Sandbox
started from the digest-pinned
`vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78`
image with one vCPU, 2048 MB memory, no exposed ports, `persistent: false`, and
`deny-all` egress. Node execution and a filesystem round trip succeeded,
external HTTPS access failed as required, and explicit stop, collection, and
disposal completed. A second live probe temporarily allowed one qualification
host, replaced a harmless placeholder `Authorization` header through the
provider network policy, verified the transformed value at the remote endpoint,
and restored `deny-all` in a `finally` path. This qualifies the basic provider
lifecycle and the provider's credential-transform mechanism. It does not yet
qualify real Claude or Codex model authentication, private repository setup,
or representative model-backed job cost.

The follow-up provider probe on the same date also exposed and resolved a real
parallel-delivery race in the provider SDK's non-atomic named `getOrCreate`
flow. The adapter now reconciles the named winner and verifies immutable job
and request fingerprints before returning it. A live parallel duplicate start
returned one execution, a replacement coordinator recovered it by its opaque
handle, the qualification marker remained readable, and cancellation,
collection, and cleanup succeeded. A separate live ten-second provider timeout
was freshly observed after coordinator state was discarded and was classified
as `timed_out` from the stored timeout evidence and provider session timing.
These probes qualify the basic duplicate-delivery, restart-recovery,
cancellation, timeout, and cleanup paths. Durable job leases, process-crash
injection during an ACP prompt, and model-backed duration and cost remain for
the production worker stages.

If credential brokering is incompatible with one profile on one adapter, that
exact profile-and-adapter combination fails qualification. Another separately
qualified execution adapter may be bound without changing ACP or Builder
semantics. There is no native protocol fallback hidden behind the ACP profile.

### 8.2 Repository Provider and GitHub self-service

Repository hosting is independent from Runner, execution-host, and model
selection. GitHub is the first maintained Repository Provider; it is not the
Vercel execution provider and does not become a Core dependency. The Company
Instance binds exact source and publication providers, while the Workspace
declares only its repository identity and governance requirements.

The hosted GitHub provider uses one CompanyOS GitHub App per service
environment. The Production App is created once and may be installed by many
customer accounts and organizations. A separate Staging App prevents test
credentials and callbacks from sharing the Production trust boundary. A
customer does not create an App, download a private key, or copy a token. The
self-service flow redirects the authenticated customer to GitHub, where they
select the account or organization, choose repositories, and approve the
declared permissions.

The CompanyOS service stores the App identity and private key only in the
provider secret boundary. It stores the verified installation ID, repository
IDs, status, and provider receipt in Company Instance state. On every source
operation, the GitHub provider mints an installation token narrowed to one
repository and `contents: read`. After a checked diff passes all gates, the
GitHub proposal publisher mints a separate token narrowed to the same
repository and only the write permissions required to create the canonical
commit, branch, and pull request. Neither token is copied by the customer,
persisted in the Builder job, or passed to Claude Code or Codex.

The GitHub App defines the provider permission ceiling. The MVP requests no
Actions, Secrets, Administration, deployment, organization-management, or
branch-protection authority. Tokens are further narrowed per operation and are
revoked or discarded promptly. Installation suspension, repository removal,
permission reduction, or uninstall makes new operations fail closed and
invalidates the stored binding until re-verified.

Self-hosted and non-GitHub deployments remain first-class. A self-hosted
Instance may configure its own GitHub provider credentials, bind another
repository provider, or use a local checkout through
`LocalGitRepositorySourceAdapter`. GitLab, Bitbucket, and private-mirror
adapters must pass the same source and publication conformance contracts; they
do not emulate GitHub App semantics in Core.

The Stage-0 private-repository harness now invokes the implemented GitHub App
provider through `RepositorySourceAdapter`, verifies the installation and exact
selected repository, requests a single-repository read token, materializes the
exact base, revokes the token, and checks the resulting local Git configuration
and remotes. With a separately authorized publication branch it creates one
bounded checked diff, requests a distinct single-repository publication token,
requires GitHub to return a draft pull request, and proves that a repeated
request returns that same proposal. The live supervised pass on 2026-08-26 used
the service-owned Production App against one selected private Workspace and
left the exact-base checkout credential-free. It did not export that private
repository to the coding execution provider. The deployed self-service
onboarding callback and end-to-end coding transfer remain separate gates.

### 8.3 ACP profile compatibility

ACP standardizes the client-agent exchange but does not guarantee identical
security, tool, auth, event, or session semantics across implementations. The
Claude and Codex profiles must pass one CompanyOS-owned conformance suite before
either can be selected by an Instance.

The MVP uses only the stable ACP v1 subset required for fresh one-shot Builder
jobs. Provider-specific extensions are recorded as evidence but cannot become
required CompanyOS semantics without a separate reviewed decision.

The first live Stage-0 profile probe on 2026-08-26 used the official TypeScript
SDK `1.4.0`, `@agentclientprotocol/claude-agent-acp` `0.70.0`, and
`@agentclientprotocol/codex-acp` `1.6.2`. Both profiles initialized ACP v1,
created a fresh session, emitted structured updates and tool events, changed
one bounded temporary fixture, terminated normally, and produced a Git diff
that CompanyOS read independently of ACP output.

The probe also found a meaningful implementation difference. Codex completed
the bounded edit without an ACP permission request; therefore Sandbox and
post-diff validation remain mandatory security boundaries. Claude emitted one
path-scoped `edit` permission request. Its path used the canonical macOS
filesystem spelling while the host fixture used a symlinked spelling. The
CompanyOS client now canonicalizes existing paths and their parent directories
before deciding workspace containment, and has a regression test for that
case. Brokered model authentication and real-profile cancellation remain open
qualification gates; the successful local probes used existing local login
sessions and passed no model API-key environment variables.

The repository also contains a fail-closed live model qualification harness.
It installs only the exact ACP profile in a disposable Sandbox, gives the
coding process a fixed placeholder credential, and configures a host- and
request-scoped Vercel header transform that holds the real credential outside
the process. It rejects missing external qualification inputs before creating
provider resources. The general `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
bindings now exist as Sensitive Production variables, but Vercel intentionally
does not return their values outside a deployment. Their live passes therefore
remain open until the harness runs in an isolated target deployment; importing
the complete unrelated Production environment into a local process is not an
acceptable shortcut.

## 9. Success and graduation criteria

The proposal-only MVP is successful when:

- an authorized Slack message resolves deterministically to the Builder;
- Builder conversation does not start a coding agent before explicit
  confirmation;
- a duplicate request cannot create a duplicate published proposal;
- GitHub self-service installs the one service-owned App without requiring a
  customer-created App, private key, or copied token;
- repository removal, permission reduction, suspension, and uninstall fail
  closed before source materialization or publication;
- the exact base commit, execution adapter and version, coding-agent profile and
  version, and resulting commit are recorded;
- Claude Code and Codex both pass the required ACP conformance suite;
- the coding agent cannot access production state or publish directly;
- post-run inspection detects every changed path independently of ACP output;
- invalid or protected diffs produce no branch or pull request;
- valid proposals pass the same Workbench checks used by humans and CI;
- every published proposal links the requester, plan, diff, tests, evidence,
  and required human authority; and
- no Builder proposal merges or deploys itself.

Graduation beyond proposal-only mode requires a separate approved decision
after 10 to 20 real changes have accurately predicted scope, consequence,
validation, and required approval.

## 10. Required verification before handoff

Each implementation stage runs the checks appropriate to its diff. The final
MVP handoff requires at least:

- `pnpm companyos inspect-core --plan <core-change-plan>`;
- `pnpm docs:check`;
- relevant unit and integration tests;
- AgentResolver route and fail-closed tests;
- Builder job idempotency and recovery tests;
- Repository Source and Proposal Publisher conformance tests, including local
  and hosted GitHub profiles;
- GitHub installation, selected-repository, token-scope, revocation, and
  uninstall tests with no credential in the coding-agent environment;
- shared ACP conformance tests for Claude Code and Codex;
- sandbox containment and credential-exposure tests;
- Workbench diff-classification and protected-path tests; and
- a model-backed proposal-only Slack round trip with no merge or deployment.

## 11. Decision evidence

- OpenClaw separates provider, model, agent runtime, and channel, keeps a
  host-owned harness boundary, uses a native Codex App Server harness for its
  deepest Codex integration, and uses ACP/acpx for Claude Code and other
  external coding agents:
  <https://docs.openclaw.ai/concepts/agent-runtimes>
- ACP v1 defines initialization, session creation and loading, prompting,
  structured updates, permissions, filesystem and terminal capabilities, and
  cancellation over JSON-RPC:
  <https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx>
- The official TypeScript SDK keeps stable ACP v1 separate from experimental
  ACP v2:
  <https://github.com/agentclientprotocol/typescript-sdk>
- The Claude ACP adapter delegates to the Claude Agent SDK:
  <https://github.com/agentclientprotocol/claude-agent-acp>
- The Codex ACP adapter delegates to the Codex App Server:
  <https://github.com/agentclientprotocol/codex-acp>
- OpenClaw's `acpx` demonstrates one headless client surface for persistent and
  one-shot ACP runs across Claude Code, Codex, Gemini CLI, and custom agents:
  <https://github.com/openclaw/acpx>
- Vercel documents Sandbox as ephemeral compute for untrusted or AI-generated
  code with isolated microVMs and SDK-managed execution:
  <https://vercel.com/docs/sandbox>
- Vercel documents egress allowlists and credential brokering that can keep
  provider credentials outside the Sandbox:
  <https://vercel.com/changelog/advanced-egress-firewall-filtering-for-vercel-sandbox>
  and
  <https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox>
- Vercel documents private repository setup with short-lived GitHub App
  installation tokens:
  <https://vercel.com/kb/guide/sandbox-private-github-repositories>
- GitHub documents that one third-party App may be installed on many accounts
  and organizations while each installation selects its permitted
  repositories:
  <https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party>
- GitHub documents on-demand installation tokens, including repository and
  permission narrowing and one-hour expiry:
  <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>
- GitHub documents that malicious code executed in a workflow can harvest the
  job's `GITHUB_TOKEN` and referenced secrets even when log redaction is active:
  <https://docs.github.com/en/actions/concepts/security/compromised-runners>
