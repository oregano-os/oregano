# Legacy Integration Runbook (external agents, automations, workflows)

> **Frozen design source since 2026-08-14.** This document is retained for its
> Stage 1 integration reasoning but is no longer an active runbook. Current
> placement and security rules live in `docs/architecture/system-boundaries.md`
> and the Workbench Guide `configure-a-connection`. Reverify and migrate a
> provider-specific process before using it operationally.
>
> **Status: DESIGN, pre-trigger.** Level 1 is possible today conceptually;
> Levels 2–3 require separately approved Connector and federation contracts.
> Nothing here grants current build or execution authority.

## The principle

External agents are **actors and triggers — never the runner.** They dock at
exactly three points, all of which already exist in the design:

1. **Identity** — a principal entry in `handbook/roster.md`, like any human.
2. **Ingress** — the existing entrances only: Slack message or webhook POST.
3. **Acting inside the system** — the runner's tool facade (later: MCP).
   R logic stays server-side; an external agent can *request* an approval,
   never grant one.

The anti-pattern: letting the external agent do the work on foreign
infrastructure and only "report results". No events, no input_hash
approvals, no snapshot hash — the proof chain is gone.

## The three integration levels

| Level | External agent may… | Requires | Trigger |
|---|---|---|---|
| 1 — Trigger | start workflows (dumb timer/webhook caller) | roster entry + token on the webhook ingress | possible today; build on first real need |
| 2 — Actor | act inside the system via the runner's tool facade (`record_event`, `request_approval`, …) | approved capability channel over the runner, scoped tokens | first approved actor-channel implementation |
| 3 — Workflow federation | be called as a step inside our workflows (or call ours) | integration contract file, evidence duty | first real federation case, after Level 2 |

Candidate transports (noted 2026-07-27, no decision): Level 2 is MCP
territory ("MCP for capabilities"). For Level 3, **A2A** (Linux Foundation,
150+ orgs) is the standard candidate — Agent Card for discovery, task
lifecycle incl. `input-required` (maps to our parking/approval wait),
artifacts as structured results. A2A is the TRANSPORT of federation, never
the decision: it has no notion of roster, R levels, approvals, or evidence —
that layer stays ours regardless of protocol. Decide when the first real
federation counterparty speaks A2A.

## File conventions (where an integration lives)

Per company — the integration IS a file change, nothing else:

- `handbook/roster.md` — the external principal (e.g.
  `anthropic:agent:monday-reporter`, `mcp:<vendor>-agent`), its role, its
  allowed R levels, and a **human owner**. No agent without a responsible
  person.
- `connections/<name>.md` — the declarative connection (endpoints, channel
  mappings, token ENV *name* — never secrets), same pattern as
  `connections/slack.md` today.
- Level 3 additionally: an integration contract in the connection file —
  defined input, defined output, `risk:` declaration, `evidence: required`.
  An external agent called by a workflow **is simply a tool**: the existing
  tool/risk mechanics cover it, including the Stage-4 default (no `risk:`
  declaration → treated as R3 at runtime → parks).

Cross-cutting rules that carry over unchanged:

- **Registration itself is R3.** Who may act in the company is a
  constitution change: file change → commit → approval click → deploy.
  `companyos validate` (Stage 4) enforces: external principal without a
  roster entry = deploy error.
- **Truth stays inside.** If the external agent needs our SOPs/skills, a
  `company:sync`-style mechanical step exports a snapshot bundle with a
  hash; its events carry that hash. Outside is always a disposable artifact.
- **Evidence.** Results of external agents are claims until backed by
  third-party evidence (message ID, API response, …) — the Stage-2
  third-party-evidence principle, generalized. Without evidence the event
  is recorded as a claim, not a fact.
- **Import, don't federate, what should become ours.** An external workflow
  that is to become a permanent part of the company gets translated into a
  canonical `workflows/*.md` (versioned, approvable). Federation (Level 3)
  is only for things that *should stay foreign* (vendor/SaaS agents).
  Two representations of one workflow violate canonicity (Spec §3.4).

## Relationship to the Builder

The **mechanism** needs no Builder: a human (or a Claude Code working
session) can write roster entry + connection file, commit, get the R3
click, deploy. The **"simple for the user" experience** — user states a
wish in Slack, an agent interviews, scaffolds the files, presents ONE R3
button — is exactly the Builder role. Until the Builder trigger is reached:
integration wishes land in `builder-training.jsonl`; each manually executed
integration (by us, with approval) is a training example and, in sum, the
Builder's specification. Integration is not a reason to build the Builder
earlier — it will be one of its main use cases.

## Runbook — Level 1 (the only executable part today)

Skeleton; flesh out on the first real integration and keep it current.

1. **[human]** Decide: who is the human owner of this external agent?
   Which workflows may it trigger? (No owner → no integration.)
2. **[agent]** Add the principal to `<company-workspace>/handbook/roster.md`
   (principal, role, allowed R levels, owner).
   - Verify: roster entry present, owner named, no R3-approve rights.
3. **[agent]** Create `<company-workspace>/connections/<name>.md` —
   declarative, token ENV name only, never the secret.
   - Verify: file contains no secret material.
4. **[human]** Provision the token (Vercel env), configure the external
   agent with the webhook URL + token.
   - Verify: a test POST from the external agent produces a workflow run
     whose events carry `actor` = the new principal.
5. **[agent]** Confirm rejection path: a POST with an unknown/missing token
   is rejected at the entrance (before any model sees content), and the
   rejection is logged.
   - Verify: rejection event with subject_principal in the events table.

Levels 2–3: do NOT write runbook steps until their triggers are reached —
steps for unbuilt mechanics would be invented, not distilled.
