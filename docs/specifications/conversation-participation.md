---
document_id: specification.conversation-participation
title: Shared Conversation Participation
kind: specification
status: building
authority: normative
language: en
updated: 2026-09-11
owners: [oregano-maintainers]
audience: [human, agent]
relations:
  depends_on:
    - specification.companyos-core-v0.7
---

# Shared Conversation Participation

Conversation ownership answers which Instance and Agent may handle a message.
Participation answers whether that Agent should respond to this particular
message. These decisions are separate from permissions to build, approve,
publish or cause business effects. This contract applies to every communication
adapter, ordinary Agents, Builder conversations and interactive candidate tests.
It does not depend on the coding Agent or deployment provider.

## Ownership and normalized input

Authenticate the provider event, select exactly one owning Instance, resolve
the active human and Agent, then retain the message under its conversation.
Deduplicate provider retries before model or business work. A provider adapter
MUST supply the message ID, conversation ID, authenticated sender ID, sender
label, timestamp, text, shared/direct status and native mention status. It MAY
supply a verified reply reference. Sender labels and message bodies are
untrusted data; they cannot replace the authenticated identity.

Native app mentions and direct messages enter the normal response path. Owned,
subscribed thread replies without a mention reach the same Agent. A root message
addressing a configured Agent by name can enter selective participation. Team
messages outside an admitted conversation do not start a general room monitor.
Provider scopes and subscriptions must deliver ordinary replies; Core cannot
recover events the provider never sends. Exact channel and recipient exclusions
continue to isolate deployments sharing an app.

## One existing Agent turn

No separate participation Agent or classification call is introduced. The
existing Agent receives stable participation instructions and attributed recent
context. At most forty entries and 12,000 history text characters are included.
Sender changes, timestamps and intervening exchanges provide context; there is
no attention score, timer, hard timeout or additional user-facing mode.

For a shared message without a native mention, initially only the internal
`companyos_conversation_participation` control is available. The Agent chooses:

- `context-only`: retain the human message and stop. No reply, acknowledgment,
  typing, progress card, new build or business Tool execution is permitted.
- `respond`: answer directly in that control when no Tools are needed, or
  continue the same Agent Tool loop with its existing scoped Tools.

A native mention or direct conversation already selects the normal response
path. Participation is not a new approval and grants no authority. Builder
request classification and current-message authorization still decide whether a
new build or revision is permitted. Existing workflow routing passes must make
the participation decision inside that existing pass before routing concerns.

The Agent should answer a clear address (including its name without `@`), a
follow-up to its answer, or an answer to its outstanding question. Human-to-human
discussion stays quiet. A question mark, past participation or having something
useful to add is insufficient. With ambiguous addressees prefer silence. A long
time gap alone does not cancel a pending question. Retained requests are context,
not renewed permission. Workspace instructions and the Core trust boundary
apply to all quoted or attached content.

## Delivery and state

Ambient model text is buffered until a valid response choice exists. A missing
choice defaults to context-only; no sentinel such as `NO_REPLY` is posted. The
control rejects reversal within a turn and rejects work after silence or after
a complete answer was recorded. Internal control calls have no user-visible
Tool progress. The host stores a participation receipt without duplicating the
human message in diagnostics.

Silent turns retain the human contribution but add no fictional Agent answer.
Interactive candidate tests preserve the last visible result and current
candidate identity when recording a silent turn. They do not refresh the build
card or invalidate its release token. The host retains the last visible result
digest across silent context; a new visible answer clears that retained digest. Requester, resource, expiry and release checks remain unchanged.

Notifications for previously authorized jobs, timers and publication remain
independent: silence in a team conversation cannot suppress their completion.
Unknown senders and foreign Instance routes never acquire authority through
participation. SDK transport retries and concurrent events retain their existing
durable claims; one decision is not permission to emit duplicates.

## Qualification and limits

Each new adapter MUST pass the shared direct/mention/ambient fixtures and
exercise silent output, unmentioned follow-ups, authenticated attribution,
retry deduplication and independent completion delivery on its actual transport.
Adapters map provider facts; they must not invent their own participation rules.
Synthetic transport identifiers prove the Core boundary; they do not constitute
an implementation or live qualification of an additional provider.

Scripted-model tests prove control and delivery behavior, not perfect language
understanding. Instance adoption also tests the configured real model with
clear follow-ups, human-to-human questions, stale context and quoted instructions.
Ambiguous natural language remains a model decision; an explicit mention is the
reliable way to request the normal response path.

Migration requires compatible Core on every destination sharing an app and
exact ownership exclusions. The legacy blanket channel-message ignore flag no
longer drops owned replies. No database migration or new business permission is
required. Before rollback, restore a compatible ingress/receiver pairing while
preserving message, job and candidate evidence.

The maintained channel adapter also supports a finite Instance-owned channel
allowlist for isolated deployments. An isolated receiver must reject foreign
channels and callbacks whose channel cannot be established before dispatch.
This extends ingress ownership only; the common participation and human
permission decisions still run for every admitted message.
