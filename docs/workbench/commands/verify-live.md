---
document_id: command.verify-live
title: companyos verify-live
kind: command
status: implemented
authority: canonical
language: en
updated: 2026-09-06
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

```bash
companyos verify-live --state <file> [--scope starter|workflow] [--format human|json]
```

The default `starter` scope is the completion boundary for the full Codex and Claude Code starter
runbook. It fails unless fresh or recorded evidence proves:

- the GitHub Workspace repository is private and one hosted-protection attempt
  was recorded as `enforced` or `advisory`;
- the operating change passed the required check and the Workspace Steward authorized its merge;
- the named Vercel, Neon, and Slack resources are present in setup evidence;
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
- the nonce-bound human Slack message and Oregano's exact
  `Setup-Test <nonce> successful.` response were persisted in the same Neon
  conversation with a non-secret response ID, response model, and token-count
  evidence from a real selected-model call.

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
free plan produces informational evidence and does not fail this Tool-free
supervised scope.

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
  "expected_approvers": ["slack:T10001:U10002"]
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

The command sends only `{"action":"verify","runId":"…"}` to the authenticated
workflow operator endpoint. It does not open or resume the run, answer a human
decision, synchronize a source, migrate a database or invoke a provider effect.
The maintained Vercel profile requires exact deployment ID, environment and
runtime Core commit, plus matching current Artifact and historical run pins.
The expected human principal set must match the actual approved decisions.

The required evidence covers one completed ordinary run with a durable wait,
Records completeness claims, delivered and answered human decision, consumed
bound approval, and a completed batch with per-item provider versions. The
reader verifies the complete bounded revision journal and effect input/output
digests. An incomplete run, unknown effect, missing receipt, changed identity,
missing check, oversized response or synthetic evidence returns nonzero exit
status. Successful readiness is `validated` at scope `live-workflow-instance`.

This verifies retained execution evidence from the exact maintained deployment.
It does not independently prove provider history, replace actual source
qualification and manual comparison, establish restart/rollback behavior, or
complete the pilot weeks and production authorization. Preserve those separate
receipts alongside this verification result.
