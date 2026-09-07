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

## Verify the full startup before promotion

Prepare the Artifact and any external Company Records configuration together.
Their Core, Workspace and Instance identities must match exactly, including when
a deployment changes only the ingress guard. Reuse reviewed source declarations
and permissions; a new Core commit is not a new source authorization.

The health check constructs the chat runtime and validates its Connector
configuration before reporting ready. This makes no provider calls and sends
no messages. An initialization failure remains a failure on repeated requests;
the runner never caches a chat before registering its handlers. After correcting
configuration, deploy and verify the exact pairing again. Health alone does not
prove incoming Slack delivery or a model response. Complete a real reply test.
