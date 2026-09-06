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
updated: 2026-09-06
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
