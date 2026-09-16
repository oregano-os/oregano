### Phase 7: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `recall "{name}"` — does a people page exist?
2. If NO → create via the enrich skill (`skills/enrich/SKILL.md`). Every
   person who was actually IN the meeting gets a page, even a thin one. Skip
   only ephemeral third-party mentions (a name invoked about someone not
   present, with no standalone context) and non-participants (a server taking
   orders).
3. If YES → update compiled truth with meeting context (subject to Phase 6).
4. Add a timeline entry on the person's page:
   `remember` with `timeline_add: {date, summary, detail?, evidence}` on the
   existing person's page, its read content hash and repository revision. Include
   the meeting's canonical link in summary/detail and original-source evidence in
   evidence/provenance. Core preserves the rest of the page. Use complete Markdown
   instead for a new page or changed current knowledge; corrections never blindly
   append a contradictory event.

Back-link known people who are MENTIONED or SPEAK in the transcript too, not
just attendees — but high-confidence identifications only. Never backlink a
garbled name or a low-confidence guess; a wrong backlink pollutes the graph
worse than a missing one.

**Note:** Complete these links within the same bounded Agent task, using the
Workspace page mappings. Save the source and meeting first, then enrich individual
entities in small writes. Do not hold every page for one combined write batch.
Sync derives graph links and computed incoming links. There is no separate
link-writing Tool or auto-link response contract.

### Phase 8: Entity propagation + timeline merge (MANDATORY)

For each company, project, or concept discussed:
1. Check the brain for an existing page (`recall`, then `entity`).
2. Create/update as needed (claims subject to Phase 6).
3. Add a timeline entry referencing the meeting.
4. Back-link from entity page to meeting page.

Inventory notable subjects from the source, not only the links already drafted
on the meeting page. The Workspace's own company is included when its operations,
decisions or processes are discussed. People pages do not replace company knowledge.
Apply the filing/notability gate to incidental mentions; report any unresolved
subject instead of silently omitting it.

**Timeline merge:** the same event appears on ALL mentioned entities'
timelines. If alice-example met charlie-example at acme-example, the event
goes on alice-example's page, charlie-example's page, AND acme-example's page.
For a multi-company session (e.g. group office hours), disaggregate the
feedback per company — each company's timeline entry carries its own content,
not a blob about the whole session.
