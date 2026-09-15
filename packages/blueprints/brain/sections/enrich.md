## Contract

This skill guarantees:
- Every enriched page has compiled truth (current-knowledge section) with inline citations
- Every enriched page has a timeline with dated entries
- Back-links are created bidirectionally
- Scale page detail to supported source content; this does not select another model or external data source.
- No stubs: every new page has meaningful content from supplied evidence or existing brain context

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/_brain-filing-rules.md` for format.

## Philosophy

A brain page should read like an intelligence dossier, not a LinkedIn scrape.
Facts are table stakes. Texture is the value -- what do they believe, what are
they building, what makes them tick, where are they headed.

## Citation Requirements (MANDATORY)

> **Convention:** see `skills/conventions/quality.md` for citation formats and source precedence.

When sources conflict, note the contradiction with both citations.

## When To Enrich

### Primary triggers
- User mentions an entity in conversation
- Entity appears in a meeting transcript or email
- New contact appears with significant context
- Entity makes news or has a major event
- Any ingest pipeline encounters a notable entity

### Do NOT enrich
- Random mentions with no relationship signal
- Bot/spam accounts
- Entities with no substantive connection to the user's work
- Same source version already completed without new signal; existing workflow checkpoints prevent duplicate processing.


### Step 1: Identify entities

Extract people, companies, concepts from the incoming signal.

### Step 2: Check brain state

For each entity:
- `recall "name"` -- does a page already exist?
- **If yes:** UPDATE path (add new signal, update compiled truth if material)
- **If no:** CREATE path (check notability gate first, then create)

### Step 3: Extract signal from source

Don't just capture facts. Capture texture:

| Signal Type | What to Extract |
|-------------|----------------|
| Opinions, beliefs | What They Believe section |
| Current projects, features shipped | What They're Building section |
| Ambition, career arc, motivation | What Motivates Them section |
| Topics they return to obsessively | Hobby Horses section |
| Who they amplify, argue with, respect | Network / Relationships |
| Ascending, plateauing, pivoting? | Trajectory section |
| Role, company, funding, location | current-knowledge section (hard facts) |


Upstream Steps 4 (external enrichment) and 5 (raw-file storage) are intentionally excluded. Use supplied evidence and retained Records. Step numbers below retain the pinned source references; no missing procedure should be fetched.

### Step 6: Write to brain

#### CREATE path

1. Check notability gate (see `skills/_brain-filing-rules.md`)
2. Check filing rules -- where does this entity go?
3. Create a page using the appropriate reviewed Workspace template
4. Fill compiled truth with citations
5. Add first timeline entry
6. Omit unsupported optional sections; keep short pages meaningful with evidenced participation rather than empty placeholders.

#### UPDATE path

1. Add new timeline entries (reverse-chronological, normally extended with dated evidence; explicit correction/withdrawal remains supported)
2. Update compiled truth ONLY if the new signal materially changes the picture
3. Update current-knowledge section with new facts
4. Flag contradictions between new signal and existing compiled truth
5. Don't overwrite user-written assessments with API boilerplate

### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced

## Anti-Patterns

- Creating stub pages with no content
- Enriching without checking brain first
- Overwriting user's direct statements with API data
- Creating pages for non-notable entities
