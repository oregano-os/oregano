---
type: skill-reference
description: Evidence gates for no-feature, feature-candidate, and PRD-draft decisions.
---
# Feature decision rules

## 1. Establish a product problem

A finding passes the feature gate only when the evidence identifies a target
user, a job or goal, a meaningful obstacle or unmet need, and an observable
consequence. A requested solution may inform exploration but does not replace
the problem evidence.

Return `no_feature` when the conversation contains no product problem, is only
status or praise, is better handled by support or configuration, is already
supported, is outside the product scope, duplicates a previously analyzed
revision without new evidence, or is too incomplete to justify a candidate.

## 2. Choose the decision

### `no_feature`

Use when the feature gate fails. Record why, cite the relevant evidence, and
stop. Do not create a placeholder candidate or PRD. The workflow should not
send one Slack message per `no_feature` decision.

### `feature_candidate`

Use when a product problem is observed but one or more PRD gates are missing.
Typical gaps are weak consequence evidence, uncertain target user, one
low-severity signal, unclear recurrence, or unresolved overlap with an existing
capability. Capture what further evidence would change the decision.

### `prd_draft`

Use only when all of the following are true:

1. The product problem and affected target user are clear.
2. The consequence and desired outcome are supported.
3. The signal is either supported by at least two independent authorized conversations or is one high-confidence severe blocker in a core journey.
4. The proposed scope can be expressed with testable acceptance criteria and explicit non-goals.
5. Known overlap, privacy, security, and operational risks are addressed or surfaced as open questions.

A severe blocker is a demonstrated inability to complete a core job, or a
material security, privacy, legal, accessibility, or data-integrity risk. Do
not label inconvenience or strong wording as severe.

## 3. Set confidence

- `low`: incomplete, ambiguous, or indirect evidence;
- `medium`: direct evidence from one credible signal or partial corroboration;
- `high`: direct, specific evidence with independent corroboration, or a verified severe blocker.

Confidence describes evidence quality, not enthusiasm or business priority.

## 4. Avoid false aggregation

Count independent conversations, not quotes, attendees, repetitions, or
summary bullets. Treat records from the same meeting or copied source as one
signal. Merge findings only when they share the same target user, job, problem,
and desired outcome. Otherwise keep them separate.

## 5. Prepare the downstream action

- `no_feature`: store the decision and provenance; include only in an optional aggregate digest.
- `feature_candidate`: store a concise candidate and the missing-evidence questions; do not create a PRD by default.
- `prd_draft`: complete the bundled PRD template and submit the exact revision for human review.

Publication is a separate governed effect. A decision never grants permission
to send a message or modify a product backlog.
