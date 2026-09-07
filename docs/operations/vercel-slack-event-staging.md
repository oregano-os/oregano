---
document_id: operations.vercel-slack-event-staging
title: Stage Slack channel events on a shared app
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers: [vercel, slack]
updated: 2026-09-07
owners: [oregano-maintainers]
audience: [human, agent]
---

# Stage Slack channel events on a shared app

A shared Slack app can forward the same event to several deployments. Before
adding channel message subscriptions, protect any destination that must retain
its current mention and direct-message behavior.

Set `SLACK_CHANNEL_MESSAGE_EVENTS=ignore` on that destination and deploy it first.
The main Slack webhook then ignores ordinary public/private channel message
events. Direct messages, `app_mention` events and interactive controls retain
their existing authenticated path. The default `process` behavior is unchanged.

Verify this guard before enabling the additional app event. A separate workflow
test endpoint can process assigned test threads. This setting does not activate
a workflow, grant a capability or change the Company Workspace. Do not add
subscriptions or deploy production without the corresponding authorization.

On rollback, remove the added channel subscription first, then restore the
previous deployment and setting. An outbound message receipt does not prove
that an incoming reply will be delivered; test both directions with an authorized
participant.
