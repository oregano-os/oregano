---
type: concept
description: Fictional retention rules that expose hardcoded period assumptions.
---
# Data retention (fixture)

| Data type | Location | Rule |
|---|---|---|
| Contact data without a deal | Event DB | anonymize after **90 days** |
| Board mirror | Event DB | keep while the item exists, then aggregate |
| Transcripts / raw personal material | outside git (`private/`, later Blob/DB) | **never in git**; delete after 30 days |
| Aggregated metrics | Event DB, learnings skills | indefinite — no personal data |
| Chat threads with personal data | Slack | workspace retention: **60 days** |

## Rules

1. Anonymize instead of delete where possible.
2. Personal data never enters the git history.
3. Enforcement: monthly retention run with a log event.
4. Roster identities: keep while the member is active; on departure set
   `status: inactive` — never delete the line (history must stay explainable).
