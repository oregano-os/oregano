---
document_id: operations.workflow-engine
title: Hosted Workflow Engine Operations
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: general
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Workflow operations

Use this guide to check whether a hosted workflow is ready for human testing.
It defines the evidence required, independently of the hosting or chat provider.

## Replies to delivered reports

When a workflow publishes an addressable message, Core retains the exact sent
text alongside its verified receipt and conversation address. A later reply can use that text
even after the workflow finishes or is cancelled. This is evidence for an
explanation, not permission to resume work or execute a Tool.

The context reader accepts opaque surface, account, conversation and thread
identities from an authenticated adapter. It contains no provider address parser
or SDK. The maintained host passes the resulting evidence to the owning Agent
alongside ordinary chat history. Another communication adapter must authenticate
its own inbound messages and normalize its receipts to the same contract. A
receipt's `thread_reference` is an opaque conversation reference; it need not
represent a threaded user interface. Without a stable reply reference, a
successful send alone cannot establish follow-up context.

Check these cases before inviting a tester:

- Reply to a newly delivered message after its workflow completes. The Agent
  should explain the message without asking the person to paste it again.
- Repeat the question after a host restart. The sent text must still be available.
- Verify that another private recipient, account or conversation cannot read it.
- Verify that discussion does not record a decision, reopen a run or grant Tools.

Context uses at most 40 messages and 80,000 content characters and reports
truncation. It expires with its delivery assignment, which defaults to 30 days.
The reader uses the current active human roster, enabled workflow list and
current Agent definition; it rejects conflicting Agent ownership. Text is a
snapshot of what was sent, not a claim about later external edits. Existing
publications from before this correction lack the retained text and are not
silently reconstructed from changed business data. Publish a new report through
the normal authorized workflow to test the complete path.

Provider-specific setup is described in the
[maintained runner guide](vercel-workflow-runner.md). Synthetic adapter tests
prove the shared contract; they do not qualify an additional live provider.

Before inviting a human tester, verify the effective model task, model and
provider route for each participating Agent. Compare them with the intended
Instance configuration; a successful health response with the wrong model is
not acceptance. Test conversation quality using the compiled instructions and
Skills, including irrelevant, incomplete and contradictory answers. Preserve
the actual response-model evidence. Schema checks and simulated collection
objects prove structure, not the quality of a model conversation.

## Choose the provider guide

- [Vercel Runner setup and recovery](vercel-workflow-runner.md)
- [Vercel Connect interaction routing](vercel-connect-workflow-interactions.md)

These guides describe the maintained reference implementation. Other adapters
must provide equivalent identity, decision, persistence and effect checks.

## Check startup before inviting a tester

The deployed Artifact and any separately stored configuration must identify the
same Core commit, Workspace commit and Instance. Prepare, deploy and roll back
that set together. A successful build does not check the settings in a running
Instance.

The runtime must finish configuration validation and register its message
handlers before it reports ready or stores a shared instance for later requests.
A failed start must fail again on the next request, rather than return a partly
initialized runtime. Automated tests must cover that failure and recovery after
the configuration is corrected.

Keep three results separate: the build passed, the deployed runtime is ready,
and an actual person received an answer. Only the last result proves a working
conversation on the tested route. Test each required route, such as a direct
conversation and a shared-channel reply; success on one does not qualify another.

## What a successful decision means

Save the authenticated human decision before updating the displayed card.
Replace its buttons with a clear confirmation. A saved approval authorizes the
bound change; it does not prove that the change has executed. Verify that
separately through the effect receipt and a read of the target system.

## Hosted interaction acceptance gate

Treat these as separate checks; do not call a hosted human test ready because
only build, health, or outgoing message delivery passed:

1. Verify exact Core, Workspace, Artifact and deployment identities, isolated
   state, permitted write resources and intended recipients. Stop if any differ.
2. Verify the provider installation destination resolves to that deployment.
   Send a clearly labelled non-decision diagnostic only to an authorized test
   recipient. Check actual provider forwarding and the receiving endpoint log.
   HTTP health checks and operator calls do not exercise this path.
3. Verify unsigned interaction requests fail authentication. Never disable
   signature verification to make the test work. A diagnostic message does not
   prove button authorization; qualify that separately with a real human click.
4. Start with a real rejection: correlate the delivered request, authenticated
   human response, persisted rejection, terminal run and absent write effects.
   Confirm the original message has no remaining action controls.
5. Test a separately bound positive decision. A recorded approval is not proof
   of a completed write: inspect the effect receipt and read the target resource
   back through the qualified provider integration. Test idempotent redelivery
   and stale-input rejection with automated contract tests as well.

For each checkpoint report `passed`, `failed`, or `not verified`, its observed
version and evidence. Missing external credentials or skipped database tests are
not a passing hosted qualification. Repeat affected checks when deployment,
routing, credential placement, or recipient bindings change. Never repeatedly
ask a user to click without locating the failed checkpoint first.

If a click times out, inspect ingress delivery before assuming a decision was
lost. If controls remain visible, inspect durable decision state before asking
for another decision: authorization may have succeeded while the message edit
failed. Report these failures separately to the operator. Never manufacture a
human response or use model conversation as an approval fallback.

The response regression suite covers durable-save-before-edit, removal of
controls after approve/reject, no edit after failed authorization, and preserved
decision state after a presentation failure. These tests cannot establish a
customer's external installation routing. The hosted gate above remains an
explicit operator qualification; it is not an automatic universal setup doctor.

## Feedback while saving a decision

After the current user and exact request pass authorization, the interface may
show “Processing your decision…”. This is temporary feedback, not a new
Workflow step or a saved decision. A success notice appears only after the
decision is stored. If storage fails, show that the result could not be confirmed
and direct the user to an administrator; do not claim rejection or success.

System feedback uses the existing working language from the Workspace's company
file. New Artifacts retain it; no new required Workspace field is introduced.
The current system-message catalog supports English and German, including
regional language tags. Older Artifacts without this field, unsupported languages
and invalid tags fall back to English. Business explanations and button labels
remain authored in the Workspace. Runtime decisions stay in the Instance store.

## Check model-generated steps

For a Tool using `language.generate`, verify the exact scoped Skill binding,
Agent model task, evidence selection and output checks. Exercise the real model
through the deployed workflow before accepting the result; a mocked response
checks plumbing only. Confirm that model failure or rejected output stops
publication and remains visible in the run. Save response-model evidence and
the prompt, context and output digests with the run.

Completed generation is retained with the step, so resuming a finished run must
not generate or publish it again. An interrupted, uncommitted model call can be
repeated and incur cost. Test any publication separately for duplicate effects.
