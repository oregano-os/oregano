---
document_id: operations.vercel-connect-workflow-interactions
title: Vercel Connect Workflow Interaction Qualification
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers:
  - vercel
  - slack
updated: 2026-09-11
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Vercel Connect workflow interactions

This guide applies only to the maintained Vercel Runner with Slack through
Vercel Connect. It is not a requirement for other hosts, Teams, Telegram or
other communication adapters. Apply the provider-neutral
[Hosted interaction acceptance gate](workflow-engine.md#hosted-interaction-acceptance-gate)
in addition to this provider setup.

## Destination and environment qualification

A shared installation may add a separately qualified Connect destination at
`/api/workflows/slack` while retaining its production destination. This endpoint
ignores ordinary chat and unrelated controls; matching workflow actions still
pass through the unchanged SDK signature verifier and exact delivered-decision
authorization. Preserve existing connector environments and destinations when
registering it. A branch label or manually assigned alias does not prove Connect
can resolve that destination. If branch routing reports no reachable domain,
use a named custom test environment and its exact environment ID, then verify
real delivery to the reviewed deployment. Preserve the production destination.
Assign required secrets explicitly to the test environment under the existing
authorization; never assume Preview secret placement covers a custom environment.


## Troubleshooting observed routing failures

When Connect reports that the selected Preview branch has no reachable domain,
a successful deployment health response is insufficient. Check the destination's
project, environment or branch identity against the actual deployment metadata
and inspect Connect forwarding logs. A manually assigned URL alias does not
prove that Connect can resolve its configured destination. The verified recovery
for this failure was to bind the destination to a named custom test environment
and qualify real delivery there. This is not evidence that all branch routing
is unsupported or that every installation needs an extra environment.

Keep the existing production destination unchanged when qualifying a separate
test route. Verify environment-specific credentials and isolated state before
starting any workflow. Creating a custom environment alone does not restrict a
credential's provider permissions; explicit Instance resource bindings and the
provider's own permissions remain necessary.

For a Slack timeout or unchanged decision card, inspect these checkpoints:

1. Connect received the actual interaction.
2. Connect forwarded it to the intended test deployment and recorded a response.
3. The Runner authenticated it and the engine recorded or rejected the decision.
4. The original Slack card was updated after durable acceptance.

A non-decision diagnostic proves forwarding only. A real human click must prove
button identity and authorization. Never submit a manufactured human approval,
disable request verification, or route an arbitrary callback URL from a button.

## Visible processing feedback and timing

The current handler can replace the original card with a processing notice only
after the engine has checked the exact request and current human authorization.
This is not a native client-side loading button: network and verification time
still precede the update. The subsequent edit confirms the persisted decision.
If saving fails after processing was shown, the handler attempts to replace the
notice with an uncertain-result message and reports the failure separately.

The handler emits `workflow.button.host-ready` duration and
`workflow.button.phase` milestones (`validated`, `processing`, `recorded`,
`resolved`). Phase durations are cumulative from entry to the response helper;
host creation is measured separately. Compare provider ingress timing as well.
No payload, credential, decision text or identity is included in these timings.
A card update failure does not roll back a saved human decision.

## Reuse an existing test environment

An existing custom test environment can host both ordinary Agent chat and declared
workflow conversations. Integrate and validate their current Core/Workspace pairing
before replacing its deployment; do not restore an older Builder or retired executor
merely to reuse the destination. Keep its retained workflow Artifacts, database,
scheduler targets and explicitly assigned credentials. Add only the reviewed test
channel bindings and keep production exclusions disjoint.

Bind ordinary chat to `/api/webhooks/slack` using the existing custom environment ID.
Keep the action-only `/api/workflows/slack` destination and production destination.
Verify actual Connect delivery after deployment. A separate Vercel project is not
required for this arrangement, and secrets assigned to the existing custom environment
should be inherited instead of copied into another project.
