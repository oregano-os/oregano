## Sensitive meetings

If the title or transcript signals legal or deeply personal content
(deposition, attorney, counsel, privileged, health): keep the page minimal and
factual, do not extract biographical color into other pages, and prefer
restraint on back-links. When in doubt about whether content should propagate,
flag the uncertainty in the processing outcome; do not invent evidence or silently report completion.

## Output Format

Meeting page created AND the verification checklist passed. Report: "Meeting
ingested: {N} attendees enriched, {N} entities updated, {N} action items
captured. Verification: passed. Sequence: PASS." If the sequence check was
waived, say so explicitly: "Sequence: WAIVED by user — {contradiction} stands
(acknowledged, not resolved)." If the recording was split, report one line per
resulting meeting page. If a claim was withheld or a contradiction flagged by
Phase 6, list each flag — the user resolves them, not silence. If any
checklist item cannot be made to pass, report the meeting as NOT ingested and
name the failing item.

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants
- Building a per-vendor pipeline or paraphrasing this skill in ad-hoc
  instructions instead of normalizing to the transcript record
- Treating a recorder auto-summary name or claim as fact without transcript
  verification
- Writing a summary's relationship/role/ownership claim into an entity page
  without finding the verbatim transcript line
- Writing a garbled proper noun bare instead of resolving canonical spelling
- Fanning an unverified claim out to multiple entity pages
- Silently overwriting established brain truth with a new meeting claim
  instead of flagging the contradiction
- Guessing a speaker identity instead of writing `[Room]`/`UNKNOWN` and flagging
- Truncating a transcript, or paraphrasing inside a quote blockquote
- Ingesting one page for a recording that contains two meetings
- Reporting "ingested" before the verification checklist passes
- Writing `- None.` under a required section to silence the checklist without
  confirming against the transcript
- Skipping the checklist because "it's just a quick logistics meeting"
- Declaring a page ingested while a sequence contradiction stands unresolved
  and unwaived
- Treating a user waive as a resolution — a waive is an acknowledgment; the
  contradiction is still in the page
- Passing a page that puts a person in two non-adjacent places with no
  transit between them
- Re-checking substance in the sequence pass (or order in V1–V5) — the axes
  are orthogonal by design
