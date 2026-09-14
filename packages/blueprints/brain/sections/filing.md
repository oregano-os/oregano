# Brain Filing Rules -- MANDATORY for all skills that write to the brain

## The Rule

The PRIMARY SUBJECT of the content determines where it goes. Not the format,
not the source, not the skill that's running.

## Decision Protocol

1. Identify the primary subject (a person? company? concept? policy issue?)
2. File in the directory that matches the subject
3. Cross-link from related directories
4. When in doubt: what would you search for to find this page again?

## Common Misfiling Patterns -- DO NOT DO THESE

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic -> `{{evidence_directory}}/` | -> appropriate subject directory | The evidence directory is for source context; subject knowledge belongs on entity pages |
| Article about a person -> `{{evidence_directory}}/` | -> `{{person_directory}}/` | Primary subject is a person |
| Meeting-derived company info -> `{{meeting_directory}}/` only | -> ALSO update `{{company_directory}}/` | Entity propagation is mandatory |
| Research about a company -> `{{evidence_directory}}/` | -> `{{company_directory}}/` | Primary subject is a company |
| Reusable framework/thesis -> `{{evidence_directory}}/` | -> `{{concept_directory}}/` | It's a mental model |
| Tweet thread about policy -> `{{evidence_directory}}/` | -> `{{concept_directory}}/` or `{{concept_directory}}/` | File by the primary subject using the reviewed directory mapping |

## Notability Gate

Not everything deserves a brain page. Before creating a new entity page:
- **People:** Will you interact with them again? Are they relevant to your work?
- **Companies:** Are they relevant to your work or interests?
- **Concepts:** Is this a reusable mental model worth referencing later?
- **When in doubt, DON'T create.** A missing page can be created later.
  A junk page wastes attention and degrades search quality.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. This is bidirectional:
the new page links to the entity, AND the entity's page links back.

Write a source-grounded Timeline entry on each affected entity page linking to the internal evidence page. Reuse that meaningful entry as the backlink; do not add a redundant Referenced-in or See-Also rewrite pass.

An unlinked mention is a broken brain. The graph is the intelligence.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

Three formats:
- **Direct attribution:** `[Source: User, {context}, YYYY-MM-DD]`
- **API/external:** `[Source: {provider}, YYYY-MM-DD]` or `[Source: {publication}, {URL}]`
- **Synthesis:** `[Source: compiled from {list of sources}]`

Source precedence (highest to lowest):
1. User's direct statements (highest authority)
2. Compiled truth (pre-existing brain synthesis)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search -- lowest)

When sources conflict, note the contradiction with both citations. Don't
silently pick one.

- Ground every claim in the source. Attribute speculation as speculation
   ("the user wondered whether…"), and never state a completion state or an
   outcome the source does not show.

## Takes attribution (v0.32+)

When writing a `<!--- gbrain:takes:begin -->` fence, the **holder** column says
WHO BELIEVES the claim, not who it's ABOUT. These six rules are the contract.

1. **Holder ≠ subject.** The test: did this person SAY or CLEARLY IMPLY this?
   - YES → `holder = {{person_directory}}/<slug>`
   - NO, it's your analysis OF them → `holder = brain`
   - Example: "Alex has a hero/rescuer pattern" → `holder=brain` (analysis ABOUT Alex, not stated BY Alex)
2. **Atomic claims.** Split compound rows into separate rows. One claim per row.
3. **Amplification ≠ endorsement.** A retweet-only signal caps at `weight 0.55`.
   The user shared something; they didn't necessarily endorse every clause.
4. **Self-reported ≠ verified.** "Sam reports 7 figures" → `holder={{person_directory}}/sam-example`,
   `weight=0.75`, NOT `holder=world/1.0`. Self-report is a strong individual
   signal, not consensus fact.
5. **No false precision.** Use 0.05 increments only (`0.35`, `0.55`, `0.75`).
   `0.74` and `0.82` imply calibration accuracy that doesn't exist. The parser
   normalizes during page validation — match the grid in your fence and avoid the warning.
6. **"So what" test.** Skip metadata-style trivia (Twitter handles, follower
   counts, obvious bio fields). A take has to be load-bearing for some future
   query.

**Holder format:**
- `world` (consensus fact, no individual claimant)
- `brain` (AI-inferred, holder genuinely ambiguous)
- `{{person_directory}}/<slug>` (individual's stated belief)
- `{{company_directory}}/<slug>` (institutional fact, no individual claimant)

Slugs use the standard grammar (`[a-z0-9._-]+`). `Alex`, `{{person_directory}}/Alex-Tan`,
and `world/alex-example` all fail validation.

**Founder-describing-own-company rule.** When a founder describes their own
company, the holder is the FOUNDER, not the company. "We can hit $10M ARR"
said by Jordan Example → `holder={{person_directory}}/jordan-example`, NOT `holder={{company_directory}}/sample-company`.
Companies don't speak; their employees do.
