### Phase 5: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

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

