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
