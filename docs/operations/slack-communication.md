---
document_id: operations.slack-communication
title: Slack Communication Delivery
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers:
  - slack
updated: 2026-09-16
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Slack communication delivery

The Slack Connector implements the general communication contract. A Workspace
chooses a logical destination and may reuse an earlier publication's
`thread_reference`. Slack account, channel and user bindings belong to the
Instance. They do not belong in general workflow instructions.

## Direct-message threads

For each direct publication, the Connector resolves the configured user's DM
through the authenticated provider. If a parent is supplied, it must be a valid
Slack message reference inside that resolved DM. Another DM, a channel, or an
invalid parent fails before publication and before the direct-message hook.
Existing account, human identity and recipient qualification still apply.

A new DM message creates and subscribes its own reply root. A reply or decision
inside an existing DM thread retains that parent and returns the new message
ID separately. The same rule applies to a later completion message. The
Connector must not silently move a failed reply to the main DM conversation.

A decision compiled as a conversation root is posted as a new DM or channel
root. After Slack returns the message timestamp, the Connector updates that same
message so the affirmative button also links to the message's own thread, and
subscribes that thread. A failed update is an uncertain effect with the published
message identity; it never posts a second card. The optional decision title
replaces the generic `Approval required` card heading.

Agent turns read up to ten earlier messages at the same place with
`conversations.history` (main channel or DM) or `conversations.replies`
(thread). The Slack app therefore needs the history read scope for each
conversation type it serves: `channels:history`, `groups:history` and
`im:history`. Without the scope the context is omitted; the turn still runs.
Thread replies arrive oldest first, so the Connector follows pagination before
selecting the latest ten replies and the root. It reads at most ten pages of
200 messages. Failed, cyclic or incomplete pagination omits this optional
context instead of labeling stale replies as recent; the turn still runs.

An original human thread reply can also be shared to the main conversation.
Slack labels this representation [`thread_broadcast`](https://docs.slack.dev/reference/events/message/thread_broadcast/).
The transport accepts it only when rereading the exact message in its original
thread. It retains the same provider event identity, account, human-author and
private-recipient checks; bot/app authors, edits and unrelated subtypes remain
rejected. A broadcast reference cannot be substituted for a new root answer.
The Agent continues in the original thread rather than posting a second answer
for the shared reference. This applies to all Agents using the Connector.

## Test the complete route

Verify a new DM question, a real reply, the review buttons in that thread, a
human decision, and the completion reply. Successful channel delivery does not
prove DM thread delivery. A working conversation alone does not prove that its
next workflow publication works.

If review delivery fails, inspect the persisted decision and effect receipt.
Recover the existing run only after verifying what was sent; do not create a
new approval or ask the person to repeat their answers. A returned message with
an unexpected conversation identity has an uncertain outcome and must not be
blindly retried. Recovery of a failed test is separate from evidence that the
original automatic path passed.

The maintained no-send verifier recognizes the former direct-thread guard,
which rejected the request before any provider publication. It requires the
exact standard communication Tool and the retained failed effect. An authorized
operator can use `recover-unpublished-decision` for that pending request. This
records one new attempt, keeps the original failure, and sends the same text to
the same destination. It does not approve the request or write to a card.
Timeouts, uncertain receipts, changed input and expired decisions do not qualify.

See [Workflow Engine Operations](workflow-engine.md) for the general execution
and evidence rules, and [Vercel Workflow Runner](vercel-workflow-runner.md) for
that hosting provider's worker and event setup.
