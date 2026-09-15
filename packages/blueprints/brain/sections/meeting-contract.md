## Contract

This skill guarantees:
- Works with normalized meeting transcripts delivered through the selected Record Sources. Source fetching/format conversion is the maintained connector's job.
- One brain page per REAL meeting — multi-meeting recordings are split first
- Meeting page created with attendees, summary, key decisions, action items,
  notable quotes
- Speakers resolved by evidence, never by guess
- Recorder auto-summaries treated as CLAIMS, not facts — every surprising claim
  passes the consistency check before it touches an entity page
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Back-links created bidirectionally
- Meeting is NOT fully ingested until enrich runs for every entity
- The meeting is never REPORTED as ingested until the verification checklist
  (below) passes — every quote grounded, every slug backed by a page and a
  timeline backlink, every speaker resolved or flagged
- The narrated SEQUENCE is verified independently of substance: a sequence
  contradiction BLOCKS ingestion until fixed or explicitly waived by the user

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

