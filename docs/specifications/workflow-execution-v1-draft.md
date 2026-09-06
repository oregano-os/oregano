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

Completeness-sensitive steps declare their evidence mode explicitly: historical
`require_synced_through` or current `require_scan_started_after`. Freshness, a
provider cursor and an unqualified empty query are not substitutes. Required
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
Entries in one approved batch may have distinct target values. The complete
ordered array, including every item's version, fields and values, is the bound
payload; matching resource bindings and full preflight remain mandatory. The
engine does not split it into separately approved or silently modified writes.

Schedules use IANA timezones, validated holiday dates and opaque trigger
parameters. Repeated trigger IDs are allowed in one calendar for non-colliding
variants; an ID cannot be ambiguous across calendar files. Variants with the
same local time and holiday shifting are rejected conservatively because they
can converge on one business day. Runtime deduplication remains mandatory.
A trigger parameter reference must exist on every variant that can open the
workflow. Configurations and templates stay inside the Workspace; symlink and
parent-directory escapes are rejected.

Only files selected by executable opening triggers, wait triggers or explicit
`calendar` paths receive the executable calendar schema. Other scheduling
metadata may coexist under `schedules/` and is not included in workflow
manifests. Discovery parses every YAML candidate when executable workflows are
present, so unreadable files cannot conceal a competing trigger. Missing,
malformed or ambiguous referenced calendars fail. A prose-only Workspace does
not acquire executable calendar requirements.

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

## Stopped-effect control notice

A stopped scalar effect with one recorded approved decision can deliver its
normalized per-item outcome to that decision's actual human approver. Core
retains frozen pages in the existing workflow state, selects the original
decision conversation and invokes the pinned publication Tool under a separate
R2 review purpose. Current recipient eligibility, exact payload, Artifact and
lease are checked again. The review purpose is trusted host context and is
never selectable through model or operator request fields.

Notice page effects have distinct identities from decision requests and
business effects. State and dispatch checks bind the exact pending page,
digest, execution step, input and active lease; cancellation shares the normal
database row lock. Successful receipt recovery does not send twice. A notice
with unknown outcome stops its own delivery, and no notice advances the
business cursor, extends an approval, or authorizes recovery. Finite size and
delivery-window bounds apply; cases outside them retain operator review.

The state extension is additive JSON in database manifest 2.0.0, with no new
table or provider migration. Historical page and decision receipts remain
immutable across worker reconstruction and cancellation.

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
conversation context. The maintained host binds provider reads as described below.

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
lands between effect claim and dispatch. These state-only tests remain distinct from the interpreter acceptance below.


## Implemented durable interpreter

`WorkflowEngine` executes the compiled forward-only graph against the retained
starting Artifact. Operator openings use an authenticated active Instance
operator and an explicit request identity; retries retain their original logical
time and reject changed fields. Scheduled openings require an active reviewed
calendar and an exact occurrence, derive their identity from declared instance
keys, and freeze that occurrence's parameters. The caller must supply business
key/period fields; Core cannot invent company period naming. Previous-trigger
references use the preceding declared calendar occurrence, never another run.
Instance execution enablement and calendar activation are separate checks.

An operator opening may select `triggerVariant`, a zero-based index among
the retained calendar entries matching that workflow's trigger ID, in declaration
order. Only that entry's frozen parameters are copied; its scheduled time is
not used as an opening time. This works with automatic calendar activation
blocked and preserves delivery windows, waits, approvals and current operator
authorization. Unknown variants and competing explicit parameters are rejected.
The hosted request still rejects caller-supplied parameters, clocks and principals.
Retained parameters participate in opening identity, so changing them under the
same request ID is a conflict. An omitted selector keeps the existing opening
behavior; it does not guess which calendar variant an operator intended.

Each Tool input or foreach collection is persisted before execution. The worker
uses a fresh lease-bound context reader for the ordinary CompanyOSRuntime;
Company Tools still execute in their existing restricted sandbox. Completed
scalar outputs and typed-key item receipts are immutable. A worker can finish
one item, restart and continue with the remaining items. Missing required
publication proof blocks the step while retaining the completed effect. Every
publication receipt must match its requested destination. A reply must also
return the exact requested thread, even though it creates no new conversation
assignment. A mismatched receipt stops dependent steps and remains retained;
operator resume cannot repair it by resending the message. An
unknown, failed or claimed effect cannot be retried by operator resume; it
requires explicit reconciliation. Successful effects recover their existing
receipt without a provider call. A read failure with no effect can resume.

Waits and business-day deadlines use the existing durable timer store. Timers
are restored from committed run state after an interrupted timer write. Their
identity includes the exact due instant, so a missed delivery window may create
a later wait without conflicting with the earlier completed timer. Only a
currently held timer claim can wake a run. State leases/revisions prevent a
second transition; a timer redelivered after a committed transition is stale.
Workers perform at most 200 transitions and stop starting transitions after
150 seconds; a single Tool remains bounded by its existing timeout. Timer
repair scans at most 200 runs, returning a run-ID continuation. Hosted workers
must retain that continuation across invocations until the scan completes.

Human decisions freeze the complete payload, digest, exact eligible recipient
IDs and business-day expiry before sending. The compiler resolves each notice
through the owner's ordinary `oregano:communications/publish` grant (below R3),
so delivery has the same effect claim, receipt and destination controls as other
messages. Each recipient receives the entire bound JSON and an exact request
ID. The v1 plain-text notice is bounded to 20,000 characters; an oversized review
blocks without truncating the payload or dispatching a partial notice.

The trusted host authenticates the actual response's principal, provider event
and exact account/channel/thread. `decide` accepts only an unexpired pending
request with a delivered notice for that current authorized human. It persists
the response before advancing the graph. Invalid responses release their lease
without granting authority. An exact already recorded provider response can be
acknowledged after completion using retained delivery proof; that lookup does
not grant active conversational authority. The effect rechecks current eligibility, payload
and expiry and consumes the ordinary Runtime approval atomically. Rejection or
business-day timeout ends the run without a write. Synthetic tests cannot stand
in for an actual human response.

Memory acceptance runs all four fictional workflows from their real entries,
including Company Tools, routes, waits, keyed messages and decisions. Mandatory
Postgres acceptance executes the same Runtime/store boundaries with retained
Artifacts, JSONB redelivery, competing responses, crash recovery, business-day
waits and cancellation before dispatch. Provider replies and test humans in
these suites are synthetic. Hosted adapters below add synthetic integration coverage. Qualified provider
completeness, real test-Instance acceptance and legacy removal remain separate
required implementation and activation gates.


## Maintained hosted adapter

The public computation fixture suite uses the maintained Company Tool source
inspector, input/output schemas and isolated runner. Frozen synthetic cases
preserve selected close, rollover and readiness comparisons without importing
legacy runtime code. This is computation evidence only: sequencing, provider
coverage, real decisions and complete legacy removal require their own gates.

The fictional close additionally exercises current work facts separately from
its frozen participant cohort. Its declared chase/report queries refresh
status, assignments and expected provider versions at the relevant instant;
an opening snapshot is not a substitute for those mutable facts. Empty changes
skip decisions and writes. Late processing preserves the wait's logical cutoff.
These are Workspace choices executed through ordinary steps, not Core business
rules or a provider coverage guarantee.

The Vercel host exposes generic timer, step, Records and operator endpoints, with strict
Artifact/Instance/environment activation and distinct scheduler/human operator
credentials. Business periods remain explicit operator inputs; automatic
opening accepts only workflows whose referenced fields are supplied by trigger
identity and run date. Durable timer jobs retain scan continuations and bounded
schedule windows. Timer repair scans active runs, and each tick bounds new work.
See [host operations](../operations/workflow-engine.md) for the exact configuration
and request contract.

The Slack adapter qualifies all destinations before preparing a message
collection and requalifies each publication within its actual token scope.
Direct roots bind the returned provider timestamp. Exact provider reply reads
prove account, human author, original content and root before `decide`; the
operator API can request a reread but cannot supply an approving principal or
response text. Workflow assignments select the retained starting Artifact ahead
of ordinary routing, with current roster checks and the waiting step's Tool
allowlist. No shared mutable Runtime is switched between concurrent conversations.

Hosted Records Connectors require a non-secret `configuration_snapshot` in the
starting Artifact. It uses the existing Records configuration validation and
exact provenance checks. Changing current environment configuration cannot
replace a historical run's sources or bindings. Qualified synchronization and
cutoff completeness remain separate source contracts; recipient qualification
or a successful worker tick cannot prove them. Test provider objects and human
responses remain explicitly synthetic until real installation acceptance.

The Records worker reuses maintained source synchronization for exact
Artifact/source pairs explicitly allowlisted by the current Instance. Retained
Artifacts need a running or waiting enabled execution in that Instance;
current-Artifact pairs may be prepared before opening. It checks eligibility
before each source read, preserves generation identity, retains bounded scan
cursors and reuses completed source receipts after restart. Removing a pair
or disabling its workflow stops future historical polling without rewriting
retained state. Poll completion does not imply qualified time coverage.

### Authenticated blocked-effect review

The engine exposes one retained effect per review page for a blocked execution.
Only a currently active human in the Instance operator allowlist can read it.
It uses the opening Artifact, exact run/step/typed item effect identity and the
ordinary effect store. The report includes run revision, provenance, effect
status, evidence digests and validated per-item Capability outcomes. Unknown
batch receipts without adequate item evidence report all requested items as
unknown; absence of evidence never means unattempted. Broken input must not
hide an already retained effect. Large foreach collections have explicit page
continuations, and raw error strings/provider payloads are not returned.

The operator review interface is read-only. Reviewing or acknowledging a report
does not reconcile an effect, release a claim, substitute a human decision or
resume execution. Automated business-owner notification and a governed recovery
path still require their own delivery and reconciliation evidence.

The synthetic close-classification Tool 6.2.0 preserves explicit actual-hours,
planned-effort and unavailable calculations as Workspace code. Missing values
remain null, excluded participants do not contribute to the total, and one
basis never substitutes for another. Its optional input defaults to unavailable;
Friday workflow version 7 passes the declared basis and renders the Tool's
scalar evidence text. The reference remains configured as unavailable. Any
operating use of numeric effort requires reviewed, typed Records fields and
projections; no provider collection is enabled by these computation fixtures.

## Completed-run evidence verification

The authenticated operator action `verify` reads a completed run and its
historical Artifact. It MUST NOT open, resume, claim, repair, consume, approve
or dispatch anything. The read compares exact run/Artifact/manifest/Core and
Workspace identities, one opening receipt, contiguous revision evidence and
the terminal state digest. Every executed step must be complete. A selected
wait needs its persisted wait and timer-fired events; a human decision needs
its matching principal, response-event identity, bound digest and finite
unexpired decision time.

The workflow acceptance scope requires at least one durable wait, approved
human decision, Records completeness proof and approved completed batch. Every
effect has its deterministic identity, exact reconstructed input digest,
retained successful output and guard evidence checked. Decision notice content
uses the same pure renderer as publication; retrospective rendering after
expiry grants no new publication authority. R3/R4 effects additionally join
the actual consumed approval and original request, compare action/input/run/
step/principal/role, and match every bound payload requirement. Batch results
must cover the exact unique item set and retain previous and resulting
provider versions. Unknown or missing effects cannot pass.

Source proofs retain the query's snapshot and complete synchronization claims;
freshness timestamps are not a substitute. This verifier does not establish a
new source-cutoff contract, independently qualify provider history, or replace
manual comparison with the actual test resource. Those remain source delivery
and Instance acceptance gates.

The read is bounded to 10,000 audit entries and 1,000 effects within a
30-second processing budget. Exceeding a bound fails explicitly; truncation
cannot produce acceptance. Checks, counts, principal identities, receipt
digests and an overall evidence digest are returned without message or work
item bodies. Synthetic evidence is explicitly identified. The maintained
`companyos verify-live --scope workflow` additionally performs a fresh
authenticated request, compares the exact deployment and expected human set,
and refuses synthetic evidence. It authorizes neither production nor a pilot.

## Current-scan workflow requirements

An `oregano:records/query` step may declare `require_scan_started_after` with a
literal timestamp or a typed reference such as `$steps.await-report.instant`.
It requests complete current observations whose provider read started at or
after that logical instant. The compiler captures this requirement and its
reference dependencies in the immutable manifest. The Runtime resolves it from
trusted run context and injects the exact query input. A delayed worker keeps
the declared wait instant; it does not silently change the deadline to its own
wall clock.

Historical and current requirements are alternatives. The authoring pass
rejects a current requirement combined with `require_synced_through`, including
when the conflicting value is supplied inside Tool input. Non-Records steps
cannot declare the option. Missing references, invalid types and unavailable
step output fail normal schema and dependency validation.

Retrospective verification requires the current query's snapshot digest and
non-empty distinct source scan proofs with exact source/declaration/run IDs,
read intervals, membership digests and watermarks. Every start must satisfy the
resolved requirement and every end must be at or after its start. The aggregate
start equals the earliest contributing start. A historical watermark cannot
substitute for current-scan evidence. The receipt records
`requirement: current-scan` and `requiredScanStartedAfter`, rather than relabeling
those observations as historical coverage.

The ordinary approval, effect, journal, exact-candidate and synthetic-evidence
checks continue to apply. `workflow-current-scans.test.ts` compiles actual
fictional Workspace revisions and runs the real engine/Runtime through waits,
a bound decision and a batch, then exercises the retained-evidence verifier.
These automated synthetic cases do not qualify actual provider scope or replace
human participation. Operating Workspace adoption and real-provider acceptance
remain separate delivery work.

## Human decision presentation

A human step may declare `message: { template, vars }` and optional
`labels: { approve, reject }`. Templates are owner Skill Markdown assets, use
scalar variables, and are captured in the workflow manifest. The same reference
and dominance validation applies as for ordinary messages. Labels are literal
single-line strings of 1–75 characters; they cannot introduce new actions.

```yaml
- review: human:owner
  binds: $steps.prepare.updates
  via: $config.delivery.decisions
  message:
    template: operations/review.md
    vars:
      summary: $steps.prepare.review_summary
  labels:
    approve: Apply reviewed changes
    reject: Keep unchanged
  timeout:
    business_days: 1
  approve: apply
  reject: end
```

Core retains the complete bound payload alongside the explanation; descriptive
text never substitutes for execution authority. Decision controls carry a
request identity derived from the run, step and bound digest. Explanations and
labels are reconstructed from the retained Artifact and prior outputs for
effect verification. Historical compiled steps without presentation metadata
retain their exact original notice inputs.

The communication Capability accepts optional provider-neutral `decision`
metadata (`request_id`, `approve_label`, `reject_label`). A supporting Connector
must render fixed approve/reject controls and route authenticated interactions
to the correct Instance. Slack uses native buttons. This contract alone does
not implement or qualify another provider. Workspace declarations contain no
Slack action IDs, provider URLs or executable callbacks.

A successful workflow button decision replaces the original card with an
explicit recorded approval or rejection and no action controls. Approval
confirmation does not claim that downstream effects have executed. The durable
engine decision precedes this transport projection; a failed card edit is
reported separately and must not be represented as a failed decision. An exact
provider redelivery can retry the projection through the engine's existing
idempotent response path. Rejected or unverified requests never close a card.
