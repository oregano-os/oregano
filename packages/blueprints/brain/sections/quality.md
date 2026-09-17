# Quality Convention

Cross-cutting quality rules for all brain-writing skills.

## Citations (MANDATORY)

Every fact written to a brain page must carry a clickable inline citation with
visible square brackets. Use an aliased internal link, not a bare prose label:
`\[[[directory/slug|Source: {kind} "{title}", YYYY-MM-DD]]\]`.
The outer escaped brackets are visible; the wiki alias is the clickable text.
Use a canonical slug from the task/read results and an accurate source label.

- **Meeting data on entity pages:** link to the meeting page using
  `\[[[{{meeting_directory}}/review-example|Source: Meeting "Review", 2030-01-02]]\]`.
- **On the meeting page itself:** cite its internal source page, avoiding a
  self-link; retain `**Original source:** [[{{evidence_directory}}/review-example|Original transcript]]`.
- **User statements, discussions, email, web or social content:** use the same
  bracketed link to the retained evidence page, with the actual context/title/date.
- **Synthesis:** link each supporting meeting/evidence page; never invent a target.

Use the same visible citation in Current knowledge and Timeline. Keep only the
readable Source citation; do not append a duplicate raw link or Source evidence
comment. A cited meeting/content page must directly link to its evidence page,
which retains the original-source URL. For `timeline_add`, put the readable
citation in summary/detail and keep canonical source slugs in `evidence`; Core
validates that the citation reaches those sources without adding hidden markup.
Without a supplied citation, Core renders bracketed source links with the event
date. Takes retain their direct evidence links; escape alias pipes inside table cells.

### Source precedence (highest to lowest)

1. User's direct statements (highest authority)
2. Compiled truth (brain's synthesized understanding)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search)

## Back-Linking (MANDATORY)

Every mention of a person or company WITH a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them.

Use the subject's dated, source-grounded Timeline entry linking to the evidence page as this backlink. Do not write a redundant Referenced-in section.

An unlinked mention is a broken brain.

## Notability Gate

Before creating a new brain page, check notability:

- **People:** Will you interact again? Relevant to work/interests?
- **Companies:** Relevant to work/investments/interests?
- **Concepts:** Reusable mental model? Worth referencing again?

When in doubt, DON'T create. A 400-follower person who tweeted once is not notable.
