---
document_id: command.verify-live
title: companyos verify-live
kind: command
status: implemented
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
    - command.setup
    - architecture.company-instance
  implements:
    - onboarding.company-workspace
---

# `companyos verify-live`

Verification still proves the deployed Artifact and exact revision pair.
After adopting `.companyos/instance.yaml`, its committed values and Artifact
configuration digest identify the reviewed Instance configuration. Merely
finding or validating the file does not prove deployment, provider access or
live readiness. See [the configuration contract](../../reference/instance-configuration.md).

```bash
companyos verify-live --state <file> [--scope starter|workflow] [--format human|json]
```

The standard `companyos setup` session invokes this command automatically.
Its chosen direct provider, exact model and Sensitive Production credential
metadata must match the reviewed binding and real response evidence. OpenAI
and Anthropic are ordinary choices; an explicitly requested alternative has
the same exact-binding requirements. Existing Gateway sessions retain their
original route and installer.
Fresh setup proves an ordinary first Slack exchange, including delivered model
response and persisted entries bound to the principal and exact Artifact.
Legacy states retain their nonce proof; they cannot use the fresh exception.
The `identity.basic` human receipt and connector-derived app Messages link are
setup inputs only. They cannot replace the delivered response or model evidence,
and verification does not request a bot credential through the personal CLI.
For fresh setups with a recorded production health alias, its current response
must also match the immutable deployment ID. An alias moved to another
deployment fails verification even if it serves an otherwise identical Artifact.
A current provider read must also confirm the same Slack app, enabled incoming
trigger forwarding, the production-only project attachment and exact webhook
route. Explicit event selections must include `message.im`. Historical
attachment receipts do not replace this check. Slack `Verified` plus saved URL
configuration establishes a handshake only; neither it nor Vercel synchronization
can replace the persisted model response. See [delivery recovery](setup.md#slack-delivery-recovery).

The default `starter` scope is the completion boundary for the full Codex and Claude Code starter
runbook. It fails unless fresh or recorded evidence proves:

- the GitHub Workspace repository is private and one hosted-protection attempt
  was recorded as `enforced` or `advisory`;
- fresh schema-5 initialization has its single scoped setup decision, create
  receipts, responsible human and exact checked initial commit;
- the named Vercel, Neon, and Slack resources are present in setup evidence;
- a fresh Vercel API read confirms Pro or Enterprise for the exact selected
  team; Hobby, an unknown plan, or inaccessible plan evidence fails
  verification even if a previous setup receipt recorded Pro;
- the selected StateStore has a valid non-secret database qualification
  receipt, and current read-only health reports the same immutable schema
  manifest digest and required feature set without running schema DDL;
- the Vercel project receipt records the maintained runner root, the Slack
  receipt records the exact trigger path and expected visible name `oregano`,
  and no unresolved provider create intent remains;
- the canonical Slack team and user principal is resolved without a stored credential;
- a structured Vercel deployment receipt is ready and current health matches
  the exact Artifact, Core commit, Workspace commit, selected Oregano Agent,
  empty ToolSet, selected model route, and exact model;
- direct-provider credential-presence and Sensitive-classification evidence
  exists when a direct recipe is selected, without a credential value in setup
  state; and
- the authorized human message and a delivered model-backed Oregano reply
  have matching persisted conversation and model-response evidence. Fresh setup
  binds the ordinary exchange to exact identity and deployment. Retired state
  versions 1–4 are rejected.

The current Core target receipt identifies additive manifest
`companyos-postgres@2.0.0`, its 69 required Knowledge tables, and its 14
required Record Source and Sprint tables. The linked
`oregano-hq-companyos` Instance last applied predecessor `1.6.0` and passed a separate
read-only verification on 2026-08-27 with digest
`b9ba518e64d39e754e917348dd67b2bad7aa200d533af8343fba0c6f3774c4b1`;
vector availability brings that predecessor's observed Knowledge table count
to 63. Manifest `1.7.0` with its second optional Retrieval-Unit vector table is
not implied by that historical receipt. Another Instance remains on its exact
older manifest until `database prepare` records an additive upgrade and a
separate read-only verification. This is schema evidence, not authorization
evidence.
`verify-live` for the Tool-free starter does not enable sensitive Sources or
Agent-facing Brain retrieval.

Successful scope is exactly `live-starter-instance`, with readiness
`validated`. This scope proves one supervised starter deployment. It does not
authorize business Tools, provider effects, unattended execution, or a general
claim that every Company Instance enforcement control has been exercised.
Hosted GitHub protection is returned separately from readiness. Losing
previously verified protection produces a warning; unavailable protection on a
free GitHub plan produces informational evidence and does not fail this Tool-free
supervised scope.

The result returns current team/plan evidence as `verification.vercel_plan`;
`LIVE124` identifies a failed plan prerequisite. This read does not change
billing, schedules, or the setup state, and applies to older state versions
as well.

`companyos bootstrap verify` remains the earlier `authoring-only-local`
checkpoint. It is intentionally insufficient for the live runbook.

## Workflow scope

```bash
companyos verify-live --scope workflow --state workflow-verification.json --format json
```

Prepare a non-secret exact-candidate file from the actual deployment and run
receipts. Replace every placeholder with its recorded value:

```json
{
  "schema_version": 1,
  "scope": "workflow",
  "instance_id": "example-preview",
  "workflow_id": "review-items",
  "run_id": "workflow:<64-hex-run-id>",
  "artifact_hash": "<64-hex-artifact-hash>",
  "manifest_hash": "<64-hex-manifest-hash>",
  "core_commit": "<40-hex-core-commit>",
  "workspace_commit": "<40-hex-workspace-commit>",
  "deployment": {
    "id": "dpl_example",
    "url": "https://example-preview.vercel.app",
    "environment": "preview",
    "protection_secret_ref": "env:WORKFLOW_PREVIEW_PROTECTION"
  },
  "operator_secret_ref": "env:WORKFLOW_OPERATOR",
  "expected_approvers": ["slack:T10001:U10002"],
  "required_evidence": ["wait", "human-decision", "record-source", "approved-batch"]
}
```

`operator_secret_ref` resolves the existing configured human operator credential
from the local environment. Its value is never stored in the state file or
returned receipt. For a protected Vercel Preview, the optional
`protection_secret_ref` resolves existing authorized automation access; the
command does not create a bypass or disable protection. That credential is
accepted only for an exact `vercel.app` origin. Both credentials must be at
least 32 characters and must not contain newlines. HTTPS origins cannot contain
credentials, query parameters or alternate paths; redirects are refused.

The command sends only the authenticated `verify` operator action with its exact
run ID and, when supplied, the requested evidence requirements. It does not open or resume the run, answer a human
decision, synchronize a source, migrate a database or invoke a provider effect.
The maintained Vercel profile requires exact deployment ID, environment and
runtime Core commit, plus matching current Artifact and historical run pins.
The expected human principal set must match the actual approved decisions.

`required_evidence` is optional; omission retains all four required controls.
An explicit set contains one to four unique values: `wait`, `human-decision`,
`record-source`, and `approved-batch`. The exact normalized set is returned
inside the evidence digest and must match the request. A review without writes
may require the first three; an immediate approved update may require the last
three. These receipts prove only their declared sets. A separate acceptance
plan must require every control its release needs across the same exact
candidate; a subset receipt cannot stand in for full acceptance.

Every executed step is still checked even when its control is not explicitly
required. Missing or inconsistent executed approvals, publications, effects,
source proofs and the complete bounded state journal fail verification.
Requested controls must actually occur: declaring `approved-batch` on a run
without a batch fails. An approved batch needs a consumed bound approval and
complete per-item provider versions. Expected approvers match every actual
approved decision; an empty expected set is allowed only without a required
human decision and with no actual approving principals.

`record-source` accepts the specific proof required by the compiled step.
Historical coverage retains `requiredThrough` and `syncedThrough`. Current
observations use `requirement: current-scan`, `requiredScanStartedAfter`, and
each source's start/end interval, inventory digest and watermark digest. The
CLI rejects mixed formats, missing membership evidence, duplicate sources,
pre-deadline starts and backwards intervals, including submillisecond instants.
A current scan is not a claim of historical reconstruction.

An incomplete run, unknown effect, missing receipt, changed identity or required
set, missing check, oversized response or synthetic evidence returns nonzero
exit status. Successful readiness is `validated` at scope
`live-workflow-instance`, limited to the returned requirements and candidate.

This verifies retained execution evidence from the exact maintained deployment.
It does not independently prove provider history, replace actual source
qualification and manual comparison, establish restart/rollback behavior, or
complete the pilot weeks and production authorization. Preserve those separate
receipts alongside this verification result.

## Verifying unpublished candidates

The same `verify-live` checks apply to an explicitly installed unpublished
candidate. A successful result proves the recorded candidate Instance and Slack
exchange. It does not prove publication, stable-release timing qualification,
or execution of the separate database integration suite. The private setup scope
and generated initialization receipt retain the candidate distribution identity.
Verification also requires the exact session-named test connector; a receipt
from the ordinary Oregano connector cannot complete a candidate installation.
