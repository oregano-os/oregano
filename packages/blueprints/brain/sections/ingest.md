## Contract

- Every fact written to a brain page carries an inline `[Source: ...]` citation with date and provenance.
- Every entity mention creates a back-link from the entity's page to the page mentioning them (Iron Law).
- Raw source versions are preserved through Records with readable original links on internal evidence pages; no parallel raw-file archive is introduced.
- current-knowledge sections are rewritten with current best understanding, never appended to.
- Entity detection covers every selected source item proceeding to ingestion; notable entities get pages or updates.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/_brain-filing-rules.md` for format.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)` (include link)
- **Synthesis:** `[Source: compiled from {sources}]`

## Phases

> **Router note:** Use this general procedure for selected discussions and the included meeting procedure for transcripts. Other specialized providers and procedures are outside this adoption.

1. **Parse the source.** Extract people, companies, dates, and events from the input.
2. **For each entity mentioned:**
   - Read the entity's page with entity to check if it exists
   - If exists: update compiled_truth (rewrite current-knowledge section with new info, don't append)
   - If new: check notability gate, then store the page in the Brain with the appropriate type and slug
3. **Append to timeline.** Add a timeline entry in the Brain for each event, with date, summary, and source citation.
4. **Create cross-reference links.** Link entities in the Brain for every entity pair mentioned together, using the appropriate relationship type.
5. **Back-link all entities.** Update EVERY mentioned entity's page with a back-link to this page (Iron Law).
6. **Timeline merge.** The same event appears on ALL mentioned entities' timelines. If Alice met Bob at Acme Corp, the event goes on Alice's page, Bob's page, and Acme Corp's page.

## Entity Detection on Every Selected Source Item

The import workflow detects entity mentions in every selected item proceeding to ingestion. It does not start a background extractor on every conversation turn.

### Protocol

1. **Scan the selected source item** for entity mentions: people, companies, concepts, original
   thinking. Account for the complete source; do not silently truncate it.
2. **For each entity detected:**
   - `recall "name"` -- does a page already exist?
   - **If yes:** load context with `entity <slug>`. Use the compiled truth to
     inform your response. Update the page if the message contains new information.
   - **If no:** assess notability (see `skills/_brain-filing-rules.md`). If the entity
     is worth tracking, create a new page with `remember <type/slug>` and populate
     with what you know.
3. **After creating or updating pages:** verify commit/sync outcome:
   ```bash
   sync
   ```
4. **Don't block the conversation.** The existing resumable workflow runs independently of the human-facing conversation.

### What counts as notable

- People the user interacts with or discusses (not random mentions)
- Companies relevant to the user's work or interests
- Concepts or frameworks the user references or creates
- The user's own original thinking (ideas, theses, observations) -- highest value
- See `skills/_brain-filing-rules.md` for the full notability gate

### What to capture from the user's own thinking

Original thinking is the most valuable signal. Capture exact phrasing -- the user's
language IS the insight. Don't paraphrase.

- Novel observations or theses
- Frameworks, mental models, heuristics
- Connections between ideas that others miss
- Contrarian positions with reasoning
- Strong reactions to external stimuli (what triggered it and why)

## Quality Rules

- Executive summary in compiled_truth must be updated, not just timeline appended
- current-knowledge section is REWRITTEN, not appended to. Current best understanding only.
- Timeline entries are reverse-chronological (newest first)
- Every person/company mentioned gets a page if notable (see filing rules)
- Link types come from the reviewed Workspace relationship mappings.
- Source attribution: every timeline entry includes [Source: ...] citation
- Back-links: every entity mention creates a back-link (Iron Law)
- Filing: file by primary subject, not format or source (see filing rules)

## Anti-Patterns

- **Appending to current-knowledge sections.** State is rewritten with the current best understanding on every update. Append-only current-knowledge sections grow stale and contradictory.
- **Ingesting without back-links.** An unlinked mention is a broken brain. Every entity mentioned must have a back-link from their page to the page mentioning them.
- **Skipping raw source preservation.** Every ingested item must have its raw source preserved. A brain page without provenance is unverifiable.
- **Bulk processing without sample test.** Test on 3-5 items first. Fix quality issues in the approach, not via one-off patches.
- **Paraphrasing the user's original thinking.** The user's exact language IS the insight. Capture verbatim phrasing for ideas, theses, and frameworks.

## Output Format

```
INGESTED: [title]
==================

Page: [slug]
Type: [person / company / meeting / media / concept]
Source: [source description]

Entities detected: N
- [entity] -> [created / updated] ([slug])

Back-links created: N
Timeline entries: N
Raw source: [Record/version reference and readable original link]
```

