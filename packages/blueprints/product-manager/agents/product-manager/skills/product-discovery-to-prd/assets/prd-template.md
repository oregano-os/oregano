---
artifact_type: prd-draft
status: draft
decision: prd_draft
analysis_id: "{{analysis_id}}"
finding_id: "{{finding_id}}"
revision: 1
---
# {{feature working title}}

## Problem

Describe the observed user problem and consequence. Cite evidence IDs for every factual claim.

## Target users and job to be done

- Target user: {{role or unknown}}
- Job to be done: {{supported job}}
- Context: {{supported context}}

## Evidence

| Conversation | Evidence ID | Support | Independence note |
|---|---|---|---|
| {{conversation_id}} | {{evidence_id}} | {{short paraphrase or minimal excerpt}} | {{why this is or is not an independent signal}} |

## Desired outcome

State the observable user or business outcome. Do not substitute a feature description.

## Why now

State supported urgency, severity, or strategic context. Label unsupported prioritization as `Inference`.

## Proposed feature

Describe the smallest coherent product behavior that may solve the problem.

## User experience

Describe the primary journey, entry point, success state, empty state, and recoverable failures.

## Requirements

1. {{required observable behavior}}

## Non-goals

- {{explicitly excluded behavior or audience}}

## Acceptance criteria

1. Given {{precondition}}, when {{action}}, then {{observable result}}.
2. Given {{failure or edge case}}, when {{action}}, then {{safe observable result}}.

## Success metrics

- Primary: {{metric, baseline if known, and evaluation window}}
- Guardrail: {{metric that must not regress}}

## Risks and safeguards

- Privacy: {{data minimization, retention, and access considerations}}
- Security: {{authority, abuse, and failure considerations}}
- Operational: {{support, reliability, and rollback considerations}}

## Alternatives considered

| Alternative | Why it may help | Why it may not be sufficient |
|---|---|---|
| {{alternative}} | {{benefit}} | {{trade-off}} |

## Open questions

- {{question that must be resolved before approval or implementation}}

## Assumptions and inferences

- Inference: {{claim not directly established by evidence}}

## Provenance

- Analysis: `{{analysis_id}}`
- Finding: `{{finding_id}}`
- Conversation revisions: `{{conversation_id}}@{{content_digest}}`
- Skill revision: `{{skill_version}}`
- Generated at: `{{timestamp}}`
- Human approval: pending
