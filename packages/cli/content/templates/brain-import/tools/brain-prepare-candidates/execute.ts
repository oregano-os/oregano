import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {lookups} = input;
  if (lookups.status === 'triage-skipped') return {requests: []};
  if (lookups.status !== 'lookup-evidence-ready') throw new Error("Complete authorized lookup receipts are required");
  const available = new Set(lookups.entities.filter((x: any) => x.result.found).map((x: any) => x.result.page.slug));
  const selected = new Set<string>();
  for (const item of lookups.entities) for (const p of item.result.candidates ?? []) selected.add(p.slug);
  for (const item of lookups.meeting_searches) for (const p of item.result.hits) selected.add(p.slug);
  if (selected.size > 200 || [...selected].some(slug => typeof slug !== 'string' || !slug.trim() || slug.length > 160)) throw new Error("Candidate page coverage exceeds the reviewed bound");
  return {requests: [...selected].filter(slug => !available.has(slug)).sort().map((slug, i) => ({key: 'candidate-' + (i + 1), slug}))};
} });
