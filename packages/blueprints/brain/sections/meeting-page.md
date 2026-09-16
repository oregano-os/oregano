### Phase 5: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}
**Original source:** {internal evidence-page link from task.evidence.link}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context. If none: _No decisions — discussion only._}

## Action Items
{Tasks with owners and deadlines. If none: _None — exploratory conversation._}

## Notable Quotes
{Verbatim from the transcript, attributed, `>` blockquotes.
If none: _No notable quotes — operational/logistics meeting._}

## Discussion Notes
{Structured notes by topic}
```

The four required sections are Summary, Key Decisions, Action Items, and
Notable Quotes — additional sections (Discussion Notes, a link to the
complete source Record) are additive, never replacements. An empty section always
carries an explicit reason; a bare `- None.` is a dodge, not an answer.

Quotes are VERBATIM. Write what was said the way it was said — a paraphrase in
a blockquote is a fabricated quote.

### Phase 6: Claim verification + consistency check (gate for every entity write)

Recorder summaries inject false facts: speech-to-text garbles proper nouns,
and AI summaries turn banter into commitments. Before writing ANY of the
following claim types to a person/company page (compiled truth, frontmatter,
or timeline), verify:

| Claim type | Verification bar |
|---|---|
| Relationship/role change ("joined as cofounder", "became CTO", "left widget-co") | Find the verbatim transcript lines. The claim must be EXPLICIT in what was said, not an inference from enthusiasm. |
| Ownership/attribution ("her project", "his company") | A speaker saying a word ≠ owning the thing. Require explicit ownership language or brain corroboration. |
| New proper nouns (project/company/product names not already in the brain) | Search the brain and supplied source evidence for the canonical spelling first. If unresolvable, annotate `(unverified spelling)` — never write it bare. |
| Major life/deal events (raised, acquired, hired, shut down) | Verbatim transcript support required. These propagate the furthest and are the most expensive to be wrong about. |
| Quantities and categories | Preserve each number's unit, population and qualifier. Counts, costs, rates and goals are different claims; do not transfer a ratio between them. |
| Decisions and implementation status | Check later corrections and explicit agreements in the complete source. Retain the final agreed rule, its alternatives and exceptions; distinguish proposed, assigned, in progress and completed. |

Apply these checks to the meeting page too, and to every repetition in current
knowledge, Takes and Timeline prose. A correct main paragraph does not excuse an
incorrect short Take or event summary. If a date conflicts with source chronology,
preserve and flag the conflict rather than silently resolving it.

For each decision and action, locate the exact supporting passage in the complete
original and check subsequent corrections before accepting the claim. Include the
full original timestamp in each Key Decisions and Action Items entry when the
original is timestamped; use the original message reference for message sources.
A date or `[Source: same]` alone is not a passage reference. Do this on the first
draft and on repairs. Citation membership is checked mechanically at completion,
but you must check that the cited passage actually supports the claim. Preserve
logical alternatives: "one of A or B" does not mean A is mandatory and B optional,
or that two different fields must both be set. Resolve "I", "you" and "we" using
the named speaker and evidenced addressee; do not substitute the speaker for the
listener. If the addressee cannot be resolved, keep that ownership uncertain.
Compare the saved decision/action wording against those passages again during
final verification, not only against your own earlier summary.

**Consistency check — transcript support alone is NOT sufficient.** A claim
can be faithfully transcribed and still wrong. Every claim that passes the
transcript bar ALSO gets:

1. **Brain contradiction check.** `recall "{entity}"` and read the
   relevant pages. Does the new claim CONTRADICT established brain truth?
   When it does, the ESTABLISHED truth wins by default — flag the conflict to
   the user, don't silently overwrite. New claims override old truth only with
   explicit, verbatim, unambiguous transcript support, and even then the
   change is flagged in the ingest report.
2. **Logic/plausibility check.** Is the claim POSSIBLE given what else is
   known? Two people can't both independently "start" the same project; a
   company founded last year can't have been acquired five years ago. A
   logical impossibility means a probable garble — investigate before writing.
3. **Surprise = signal.** If a claim would make the user say "wait, what?",
   that surprise is exactly when these checks are mandatory. Boring claims
   ("discussed metrics", "attended") pass on transcript verification alone;
   surprising claims need every layer. Don't rationalize surprise into a story
   that fits — surface it as a question.

**Downgrade protocol:** if the transcript supports only an inference, record
it as an explicitly-uncertain note on the meeting page — never in an entity
page's compiled truth or frontmatter.

**Propagation rule:** a claim that fails verification must not fan out. Do not
copy it to other entity pages or timeline entries. A false claim written to
five pages costs five corrections.
