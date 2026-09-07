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

## Assign a test channel to one destination

The ordinary-message guard intentionally preserves `app_mention`. If a separate
workflow destination accepts mentions too, both deployments could answer.
Set `SLACK_IGNORED_CHANNEL_IDS` on the primary destination to a comma-separated
list of exact channel IDs owned by the test destination. Deploy and verify this
exclusion before enabling mention handling on the test destination.

The primary webhook then drops both `message` and `app_mention` for those channels.
Other mentions, direct messages and interactive controls retain their existing
path. IDs must identify channels; empty entries, duplicate IDs, direct-message
IDs and wildcards are rejected. Leave the variable unset to exclude no channels.
Keep company-specific IDs in Instance configuration, outside Core source.

This needs no new Slack subscription, scope or installation. The test destination
still verifies provider signatures, human identity and the active conversation
assignment. A general Agent response is not proof that the assigned workflow
received the answer. Test the actual question-to-reply path and inspect which
workflow handled it. On rollback, stop the test destination from accepting
mentions before removing the primary destination's exclusion.

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


## Exclusive direct-message tests

A shared Slack app can deliver a person's direct message to both deployments.
Before testing a workflow in a DM, reserve its route on both destinations.
Set `SLACK_WORKFLOW_DM_RECIPIENTS` to the same exact `account:user` list, for
example `T10001:U10002`. This maintenance guard excludes those DM messages from
the ordinary webhook. Other accounts, people, channels and controls retain
their existing behavior. No credential, grant or workflow changes.

The workflow destination must run a compatible receiver that accepts the same
list and verifies its existing recipient-bound questions. Verify the exclusion
before enabling that receiver. Test real root and thread replies and confirm
exactly one assigned response. A working button does not prove text delivery.
The reservation covers the person's whole DM during the test; ordinary chat
there is temporarily unavailable. Remove the paired settings when the test ends.
Never enable only one side or treat configuration as proof of actual delivery.
