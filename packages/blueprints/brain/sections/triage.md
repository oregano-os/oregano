## Step 1: Triage Prompt (utility tier)

The triage prompt is deliberately minimal — extract ONLY what is needed for
the routing decision. Don't waste tokens on full extraction.

```
Quickly classify this [content type]. Respond with ONLY valid JSON.

[CONTENT]

{
  "filing": "category_1 | category_2 | ... | low_value",
  "user_writing_present": true/false,
  "user_writing_quality": 0-10,
  "emotional_significance": 0-10,
  "business_significance": 0-10,
  "era": "...",
  "one_line_summary": "..."
}
```

**Key design:** It is a classifier, not an extractor. Keep it tight. Measure actual runtime and cost; upstream timings are not a guarantee.

**Escalation principle (hard rule):** when in doubt, escalate a tier. The
cost of missing a significant piece of the user's writing or an emotionally
important moment is higher than the cost of an extra deep-tier call.

### Transcripts (meetings, calls)
- Triage: "Is this a real conversation or a check-in?" + "Does the user
  give substantive advice?"

### Chat archives (messages, group threads)
- Triage: "Is this a real conversation or logistics?"


## Evidence-based score calibration

Score the retained content, not the existence or packaging of a recording.
A title, participant list, known colleague, timestamp or recording duration does
not establish meaningful conversation, advice, a decision or a relationship event.
Do not reconstruct missing dialogue from those fields.

Emotional significance means a source-grounded event or reaction with lasting
personal or working significance. An isolated expletive, emphatic punctuation,
greeting or start/stop command without such context is not that evidence.
For a purely operational fragment with no supported insight, event, commitment or
meaningful emotional context, use the configured low-value category and low scores
(0–2). Explain the missing substance in one_line_summary; do not raise significance
merely because the missing context is uncertain.

Brevity alone is never a reason to skip. A single supported sentence can contain
an important decision, deadline, commitment, original idea or meaningful personal
news. Score that actual meaning normally. Escalate uncertainty about a supported
significant claim; do not invent significance in an otherwise content-free fragment.
