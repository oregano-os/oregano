## Verify before declaring done (HARD GATE)

The write phases do the work; this phase verifies the work was actually done.
Run the checklist on the finished page — every item, every meeting, including
"quick" logistics meetings. **Never report a meeting as ingested until every
item passes.** Saying "ingested" first and fixing later is a contract
violation; a false completion report is worse than an honest partial one.

**V1 — Required sections have substance.**
- `## Summary` carries real outcomes (2+ bullets or a few substantive
  sentences), not one vague line.
- `## Key Decisions`, `## Action Items`, and `## Notable Quotes` each have
  real content OR an explicit reason (`_None — exploratory conversation._`).
- A bare `- None.` or `_n/a_` written to silence the checklist is a violation.
  Before writing "none", confirm against the transcript that there truly were
  no decisions/commitments/quotes worth keeping.

**V2 — Every page referenced in either {{person_directory}} or {{company_directory}} has a page AND a timeline backlink.**
For each person/company slug referenced by the meeting page:
```bash
entity {{person_directory}}/{slug}          # page exists?
entity (Timeline text) {{person_directory}}/{slug}     # has an entry pointing back at this meeting?
entity {{company_directory}}/{slug}       # verify company pages too
entity (Timeline text) {{company_directory}}/{slug}  # verify each company Timeline backlink
```
A slug with no page means Phase 7/8 was skipped — go do it. A page with no
timeline entry for this meeting means the merge was incomplete — add it.

**V3 — Speaker map resolved.**
No `Participant N` / `UNKNOWN_N` / raw recorder labels remain in the page
without either a resolution or an explicit uncertainty flag (`[Room]`,
`⚠️ attribution uncertain`). Every named speaker carries a confidence from
Phase 4. An unflagged anonymous label means speaker resolution was skipped.

**V4 — Every quote grounded VERBATIM in the transcript.**
- **Deterministic check (transcript retained):** for each `>` blockquote,
  verify its contiguous span appears in the complete source Record. Filler words
  (`like`, `you know`, `I mean`) may be stripped from both sides; a genuine
  quote still shares a long contiguous run of content words, a fabricated one
  does not.
  ```bash
  Read the complete supplied source Record; locate each quote span in its transcript.
  ```
- **Prompt checklist (no transcript retained):** re-read the source notes and
  attest that each quote traces to them word-for-word.
- When a quote fails grounding, the fix is almost always to restore the spoken
  phrasing (or pick a cleaner contiguous span) — NOT to delete the quote, and
  never to keep the paraphrase inside the blockquote.

**V5 — Fabricated-attendee sanity checks.**
Recorders confidently invent names and emails for unlabeled speakers.
- An attendee name that appears NOWHERE in the transcript or roster evidence
  did not survive the evidence — treat it as a guess. Identify the real person
  from in-call tells (companies, shared history) or remove the name.
- An attendee email whose domain doesn't match the person's claimed org is a
  fabrication suspect (recorders commonly grab the host's domain). Verify the
  real address or clear the field.
- When either fires: do NOT auto-rename or auto-fill. Read the transcript,
  resolve by evidence, correct the page + frontmatter + backlinks, then re-run
  this checklist.

**V6 — Sequence verify (order, not substance).**
A meeting page can be right on depth and wrong on order — they are independent
failure axes, and V1–V5 never look at order. Verify the narrated sequence:

1. **Extract event atoms.** Walk the page body in document order and list each
   narrated sub-event as `{phase, place, people}` — where `phase` is its
   position relative to the meeting's central event (before / during / after)
   as the PROSE claims it.
2. **Deterministic checks** (agent-executed, mechanical — no judgment needed):
   - **PHASE_INVERSION (hard):** an atom narrated as "before" appears after
     the central event in the document's sequence (or vice versa). Example: the
     page narrates the debrief of alice-example's pitch, then narrates the
     pitch itself as if still upcoming.
   - **TELEPORT (hard):** the same person is placed in two non-adjacent
     locations with no transit or movement narrated between them. Example:
     alice-example is in the car en route in one paragraph and already inside
     the acme-example office in the next, with nothing connecting the two.
3. **Source/Timeline corroboration (soft):**
   Read the involved entity pages and their prose Timelines with entity, together with the complete source transcript. This is bounded corroboration, not a whole-Brain day-event query.
   - **DAY_TIMELINE_GAP:** a narrated participant who never appears in the
     involved pages' Timeline entries for the source event is a SIGNAL, not a hard fail — most often it
     means their timeline entry was never written (go fix Phase 7/8), and
     occasionally it means the narration names someone who wasn't there.
     Investigate; don't auto-block.
4. **Verdict — PASS or BLOCK.**
   - No hard contradiction → **PASS**. Proceed to report.
   - Any PHASE_INVERSION or TELEPORT → **BLOCK**. The meeting is NOT ingested.
     Fix the narration (re-read the transcript for the true order) and re-run
     V6 — or, if the user explicitly says the order is fine as written, record
     a **waive**. A waive is logged in the report as acknowledged, NOT
     resolved: `sequence: WAIVED by user — {contradiction} stands`.
   - Genuinely ambiguous order (flashbacks, prose that implies but doesn't
     state a sequence) is a judgment call, not a deterministic class — flag it
     in the report, don't block on it.

**The loop:** fix → re-check → fix, until every item passes (or V6 is
explicitly waived). Only then report.
