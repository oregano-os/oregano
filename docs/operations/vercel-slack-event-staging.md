---
document_id: operations.vercel-slack-event-staging
title: Stage Slack channel events on a shared app
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers: [vercel, slack]
updated: 2026-09-11
owners: [oregano-maintainers]
audience: [human, agent]
---

# Stage Slack channel events on a shared app

A shared Slack app can forward one event to several deployments. Each destination
must claim exact channels or recipients before admitting a conversation. The
legacy `SLACK_CHANNEL_MESSAGE_EVENTS=ignore` blanket filter is retired: both
`ignore` and `process` now preserve ordinary message events for downstream
subscription and participation routing. Unknown flag values still fail startup.

Before upgrading, configure and verify the exact exclusions below on every
shared-app destination. Without them, blanket-ignore deployments may start
receiving duplicate conversation events. Keep ordinary message subscriptions
available so an owned thread can continue without another app mention.

Core decides participation after ownership. Team discussion can be retained
without posting; a clear follow-up reaches the existing Agent. This adds no
workflow, grant or provider permission. Verify with an authorized thread:
mention, answer, unmentioned follow-up, human-to-human exchange, then another
explicit address. Require one answer when addressed and no answer to the human
exchange. On rollback restore a compatible ingress/receiver pairing; retain
all conversation and execution evidence.

## Assign a test channel to one destination

Both ordinary messages and app mentions require exclusive ownership. If a separate
workflow destination accepts the same conversation, both deployments could answer.
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
