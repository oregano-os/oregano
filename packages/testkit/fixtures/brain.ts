import { parseBrainConfiguration } from "../../brain/configuration.ts";
export const brainConfig = parseBrainConfiguration(`version: 1
types:
  person: {directory: people, role: person}
  organization: {directory: companies, role: company}
  topic: {directory: topics}
  source: {directory: sources, role: evidence, search_weight: 0.5}
relationships:
  employer: {relation: works_at, target_type: organization}
filing_guidance: Keep supported subject knowledge and attributable sources.
`);
export const brainFixturePage = (type: string, title: string, body: string, extra = "") => `---\ntype: ${type}\ntitle: ${title}\n${extra}---\n\n${body}\n`;
export const brainFixtureTakes = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | ~~Open the branch now~~ | take | people/alex | 0.8 | 2026-08 → 2026-09 | [[sources/review]] |
| 4 | Delay the branch | take | people/alex | 0.73 | 2026-09 | [[sources/review]] |
| 7 | A new branch may work | hunch | people/sam | 0.4 | | [[sources/review]] |
<!--- gbrain:takes:end -->`;
export const brainFiles = {
  "brain/people/alex.md": brainFixturePage("person", "Alex Example", "Operations lead.", 'aliases: [Alex]\nemployer: Example Cooperative\n'),
  "brain/people/sam.md": brainFixturePage("person", "Sam Example", "Research lead."),
  "brain/companies/example.md": brainFixturePage("organization", "Example Cooperative", "A synthetic cooperative."),
  "brain/sources/review.md": brainFixturePage("source", "Expansion review", "The participants expressed different views. [Original transcript](https://example.org/reviews/1)"),
  "brain/topics/expansion.md": brainFixturePage("topic", "Branch expansion", `No shared decision yet.\n\n---\n\nThe current account preserves differing views.\n\n${brainFixtureTakes}\n\n<!-- timeline -->\n\n- 2026-09-01: Reviewed expansion. [[sources/review]]`),
  "handbook/private.md": brainFixturePage("topic", "Outside the boundary", "Never indexed."),
};

