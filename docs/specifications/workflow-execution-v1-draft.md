---
document_id: specification.workflow-execution-v1
title: Workflow Execution v1
kind: specification
status: draft
authority: canonical
language: en
updated: 2026-09-05
owners: [oregano-maintainers]
audience: [human, agent]
---

# Workflow Execution v1

This is the implementation target for the generic workflow engine. The
compiler, runtime guard, durable engine and hosted acceptance are pending.
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
