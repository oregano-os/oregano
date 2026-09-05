---
document_id: specification.workflow-execution-v1
title: Workflow Execution v1
kind: specification
status: draft
authority: canonical
language: en
updated: 2026-09-06
owners: [oregano-maintainers]
audience: [human, agent]
---

# Workflow Execution v1

This is the implementation target for the generic workflow engine. Authoring validation, Artifact compilation and the Runtime Tool guard are implemented.
Durable engine integration and hosted acceptance are pending.
Existing prose workflows and legacy execution continue to operate until their
replacement passes the migration gates. This document is not execution proof.

The Workspace owns the process in Markdown and YAML, reviewed computation in
sandboxed Company Tools, and wording in Skill templates. Core owns scheduling,
authorization, orchestration and provider access through existing Capabilities
and Connectors. No value is computed in a workflow file: it binds literal data
or references, calls a Tool, substitutes template variables, or selects an
explicit route. Business calculations belong in a reviewed Company Tool.

## Ten v1 constructs

1. **Trigger:** a declared schedule or authenticated operator opens a run.
   Schedule parameters are opaque data; calendars carry no workflow semantics.
2. **Instance:** a declared key field list identifies the run. Scheduled
   defaults are `trigger_id` and local `run_date`, scoped by Instance and
   workflow. All key fields are present and immutable at creation.
3. **Tool step:** the owning Agent calls an exact compiled Tool with typed
   input through the ordinary CompanyOSRuntime boundary.
4. **Message:** an ordinary communication Tool substitutes a frozen Skill
   template and uses an exact Instance destination binding.
5. **Wait:** a declared trigger or a number of business days suspends the run;
   a durable timer wakes it and produces the firing instant.
6. **Decision:** an authenticated active human in a declared role decides on
   one exact bound payload, destination, expiry and resulting effect.
7. **Route:** an exhaustive named outcome selects an explicit target or end.
8. **For each:** one bounded collection is dispatched by unique, stable item
   keys. Duplicate or absent keys fail before any item effect is dispatched.
9. **References and defaults:** `$config`, `$steps`, `$trigger`, `$instance`
   and `$item` bind typed values; defaults cannot refer to future outputs.
10. **Completion and evidence:** end, rejection, timeout, failure and
    cancellation preserve the run's Artifact and all decisions and receipts.

## Authoring and compilation

The only authoring form is compact `steps:` in Workflow frontmatter. Each
single-key step has exactly one `<!-- step:id -->` body marker, in the same
order, with owner and risk matching the resolved Tool or human role. Unknown
fields, unknown output references and cyclic control flow fail validation.
Every step executes at most once per run, except keyed `for_each` instances.
There is no expression language, `kind: agent`, cross-run read or export.

The long execution manifest is compiler output. A run pins the complete
Artifact: manifest, Tool code and schemas, templates, configuration, policy
and exact Workspace provenance. Redeployment changes new runs only. Missing
historical Artifacts fail closed rather than silently switching versions.

## Safety and recovery

Trusted run context comes from persisted state, never model arguments. The
Tool boundary checks step allowlist, risk, resource or destination binding,
and the exact approved payload digest. Reserved workflow effects cannot be
called by omitting context. Authenticated conversation assignments bind a
thread or decision delivery to a run; conversation Tools remain intersected
with the waiting step's allowlist.

The first message has no thread input. Replies use its persisted provider
receipt. A successful publication is never repeated after restart; an unknown
provider outcome needs reconciliation or human review before further dispatch.
Independent runs have separate effects and timers. Redelivery reuses the same
identity, and canonical JSON equality survives a Postgres JSONB round trip.

Approval binds the complete update array, expected versions, target binding,
role, Artifact, run and step. Expired, revoked or changed approvals fail.
R4 requires separate requesting and approving humans. An empty update array
routes to end before requesting approval. Partial batch results remain partial
and cannot silently retry already applied items.

Completeness-sensitive steps require explicit `synced_through` evidence.
Freshness, a provider cursor and an empty query are not substitutes. Required
database tests must execute against real Postgres with zero skipped cases.
Synthetic tests do not replace actual human decisions, hosted test-Instance
acceptance or elapsed pilot periods.

## Implemented authoring validation

`companyos validate` recognizes `steps:` workflows alongside existing prose
workflows. The generic schemas are `workflow-steps-v1.schema.json`,
`workflow-config-v2.schema.json` and `schedule-v1.schema.json`. Schema checks
validate shape and bounds; the semantic pass resolves each compact selector
and rejects options that do not belong to that step kind. Config v2 contains
`schema_version`, `id` and arbitrary literal company parameters. Core does not
name business fields in its configuration schema. References must resolve to
actual values and cannot contain expressions or prototype paths.

Tool input literals undergo JSON Schema validation. Referenced values are
checked against producing types, required object properties and typed Record
projection rows, including multiple selected sources. Unknown output fields,
missing required row fields and incompatible nullability fail. The validator
uses the maintained Capability risk minimum, exact Agent grants, local Tool
contracts and the restricted source inspector. Instance bindings and the final
resolved ToolSet remain build-time responsibilities.

Optional output leaves referenced by later steps are required execution
preconditions. The compiler infers these paths into its manifest; the runtime must validate
them before dependent steps can advance. For example, the generic
message contract permits a receipt without `thread_reference`; a workflow
that consumes it may advance only after the actual receipt supplies it.
This does not upgrade the general Capability contract or invent a thread.
The Runtime enforces these obligations on scalar Tool receipts. The durable
engine must validate aggregate foreach outputs before advancing.

Control flow follows document order. Explicit targets may only name a later
step or `end`; backward jumps, unreachable steps and references to a producer
that can be skipped on a path to the consumer fail. `after` must name an
earlier mandatory predecessor. Routes cover a finite enum or boolean.
Human decisions bind a prior step output and require a delivery binding,
approve/reject targets and a bounded business-day timeout. The batch-update
pattern must guard its empty updates outcome before requesting approval.

Schedules use IANA timezones, validated holiday dates and opaque trigger
parameters. Repeated trigger IDs are allowed in one calendar for non-colliding
variants; an ID cannot be ambiguous across calendar files. Variants with the
same local time and holiday shifting are rejected conservatively because they
can converge on one business day. Runtime deduplication remains mandatory.
A trigger parameter reference must exist on every variant that can open the
workflow. Configurations and templates stay inside the Workspace; symlink and
parent-directory escapes are rejected.

The fictional `lindenhof-studio` fixture passes full Workspace validation and
Artifact compilation; mutation tests exercise the failure cases. The durable
engine, qualified provider completeness and actual human/Instance acceptance
remain separate gates.

## Implemented Artifact compilation

The builder captures Workspace source bytes once for Agent and workflow
compilation. The same captured bytes pass semantic validation before manifest
construction. The compiler verifies local Tool implementations against this
snapshot and exact resolved Tool contracts, including Capability risk minima.
Each workflow contains an ordered step graph with one entry, resolved Tool
identity/version/contract digest, frozen literal inputs, templates, schedules,
binding constraints, decision payload paths and required output paths. There
is no business computation or provider call during compilation.

`Artifact.workflows` is additive. Each workflow has its own `manifestHash`;
the enclosing `artifactHash` binds it together with Tool code, policy, roster,
Instance bindings and the rest of the Artifact. The manifest does not embed
the enclosing hash because that would create a circular content hash. Runtime
evidence must attach both hashes and exact provenance from the pinned run.
Build time is excluded from Artifact identity. Canonical object-key ordering
preserves both identities across a JSONB round trip.

Scheduled workflows use their originating schedule as the business-day
calendar unless `calendar: schedules/<file>.yaml` explicitly selects another.
An operator workflow with timed waits or decisions must name `calendar`.
This is engine metadata in the workflow, not a business key inferred from
opaque config. Trigger params and holiday rules are frozen unchanged.

Messages freeze their Skill body and format, destination and optional thread
or recipient references. A direct recipient still needs an exact authorized
Instance destination resolution; compilation grants no wildcard audience.
Required outputs include nested fields needed by each `for_each` item, with
`[]` marking all items. Foreach output is `{items: [{key, output}]}`. Every item
key and required item field must be checked before the first item dispatch.
A successful effect with insufficient receipt data must remain successful in
the effect store while the workflow is blocked; it must never be republished.

R3/R4 steps must consume an explicitly bound decision payload. The manifest
records its exact input path independently of the resource binding. Effects
are identified by maintained Capability mode, including low-risk effects.
The manifest reserves their Tool identities and gives waiting conversation
steps an empty allowlist by default. The Runtime guard enforces these limits.

The full generated Friday manifest is checked against a reviewed fictional
expectation under `compiler-expectations/`. Tests also cover changed sources,
config, templates, calendars and Tool versions, stale snapshots, forged risk,
root/reply references and canonical identities. These are compilation tests,
not proof that the engine has executed the workflow.


## Approval validity foundation

The generic StateStore now supplies finite expiry (24 hours for callers
without a workflow deadline). CompanyOSRuntime accepts an explicit trusted
request deadline. The workflow engine must supply the deadline computed from
the decision's compiled business-day timeout; this scheduling integration is
still pending. The atomic Postgres claim and memory adapter verify current
request, exact run/step/input, approved decision, unconsumed signature and
expiry. Expired drafts never expose an older request as current. Historical
requests without expiry remain retained but cannot authorize new effects.

These store checks are covered by real Postgres tests, including rejection
before any signature is consumed. They complement the workflow guard and pending durable role routing; they do
not replace authenticated human decision delivery.


The generic R4 boundary now records the original requester on the exact
approval request and requires a different active human with a distinct stable
roster ID at execution. Request evidence is durable in the existing Core event
store, without a separate database schema. Workflow decisions must reuse this
request path and carry the actual initiating human for R4; an Agent cannot
substitute a human identifier in Tool input. Durable workflow assignment integration remains pending.

## Implemented Runtime guard

Artifacts containing workflows require a constructor-injected trusted context
reader. The host supplies a persisted dispatch lease or authenticated waiting
conversation assignment; Tool arguments cannot select or replace this reader.
Absent assignments cannot call reserved workflow effects. A running assignment
must match the exact Artifact, manifest, run, Agent, step and subject. The guard
checks allowed Tool, resolved contract digest/version, risk ceiling and the
complete resolved input, including destination and resource bindings.

References preserve JSON types and never reinterpret provider-returned strings
as another reference. Message bodies use frozen templates and scalar variables.
Instance `workflow_bindings.direct_recipients` entries map `binding`, `member_id`
and `destination_binding`; mappings are included in Artifact identity. Missing,
ambiguous or currently inactive human recipients fail. Every foreach item key,
input and destination is checked before even the first item can dispatch.
Provider qualification must still prove each physical destination belongs to
that member before activation; the mapping alone is not provider proof.

Effect identity binds Instance, workflow, run, step and typed item key. Input
is a separately compared canonical JSON digest: changing content conflicts
with the existing claim instead of creating another send. Records distinguish
string and numeric item keys, and object key ordering cannot change identity.
Runtime events and receipts include workflow version, manifest and Artifact
hashes, Workspace commit and exact run/step/item provenance.

New R3/R4 dispatch checks recorded human decisions, the exact bound payload,
finite deadline and current human role/permissions. Model-supplied approvers
cannot replace these decisions. R3/R4 foreach is rejected: v1 requires one
bound approval and one complete batch effect. Already completed effects recover
their receipt before an expired approval can cause another execution attempt.
A refused dispatch claim never invokes a provider. Invalid effect receipts are
unknown outcomes with partial evidence; they cannot be retried automatically.
A successful send missing a downstream-required field stays successful while
the workflow stops. An audit append failure cannot overwrite a completed effect.

Tests exercise the compiled fictional Workspace through the actual Runtime,
sandbox and effect store with a Connector that has no deduplication of its own.
They prove the Tool boundary, not durable scheduling, authenticated transport
assignment or real human approval. Those remain subsequent integration gates.

## Implemented calendar evaluation

Generic calendar primitives now live outside the legacy domain. The workflow
evaluator resolves declared trigger variants, weekday/holiday shifts, opaque
parameters, business-day deadlines and delivery windows. Deadlines retain local
wall time, seconds and milliseconds across timezone offset changes. Opening is
inclusive and closing is exclusive; out-of-window delivery moves to the next
business opening. Nonexistent local times fail under the existing timezone
converter. Missing holiday years follow the explicit Workspace policy.

Wait resolution starts from the run's last logical instant, not a late worker's
current clock. This keeps a delayed same-day chase/report sequence on its
original calendar occurrence. Converging equivalent triggers deduplicate;
conflicting parameters fail. Evaluation is bounded and never activates a
calendar. The durable engine must persist each selected instant and timer.
Memory and Postgres timer identity both compare canonical JSON payloads and
include timer kind, so key reordering cannot cause a false conflict.

## Implemented durable state foundation

The generic execution store retains complete starting Artifacts, immutable run
opening inputs, step/item outputs, finite decisions, waits and exact delivered
conversation assignments. It extends `companyos.workflow_runs` and its event
chain; mutable execution snapshots and retained Artifacts stay in the existing
`companyos` control schema. Reconstructing a store never replaces a run's
Artifact with the current deployment. Run IDs bind Instance, workflow and a
stable opening key. The engine must derive scheduled opening keys from declared
instance fields and keep an explicit operator request identity for independent
runs. Reusing an opening key with changed inputs fails.

A worker holds an expiring lease for at most five minutes. State commits require
the same current lease and optimistic revision, retain completed outputs and
decision bindings, append an event, and bind delivered conversations atomically.
A conflicting conversation assignment rolls back the entire transition. Exact
account/channel/thread identity is required; private assignments additionally
require the bound subject. Expired or terminal-run assignments do not authorize
conversation context. The host still has to wire authenticated transport reads.

Cancellation and the transition to provider dispatch lock the same execution
row. A cancelled run, stale lease, changed step or blocked state cannot start a
new Tool effect. The final check also uses current database time, so a worker
cannot retain an old timestamp past its lease. An effect whose dispatch already
won the lock remains in flight and keeps its receipt; cancellation cannot undo
an external call that has begun. Subsequent dispatch is refused. Historical
rows, receipts and assignments are retained.

Database manifest `2.0.0` adds these control tables, indexes and constraints.
The `1.9.0` manifest retains its exact old digest. Mandatory Postgres tests
exercise concurrent leases, JSONB redelivery, atomic assignment refusal,
cancellation/dispatch races and the actual Runtime's refusal when cancellation
lands between effect claim and dispatch. These tests position generic state
explicitly; the complete step interpreter, scheduling/decision delivery and
end-to-end fictional workflow acceptance remain subsequent implementation.
