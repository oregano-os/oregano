import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {prepared, gate, normalization, lookups, candidates, results, prompts} = input;
  if (prepared.source_complete !== true || gate.coverage_complete !== true) throw new Error("Complete source and triage evidence are required");
  if (gate.route === 'skip') {
    if (normalization.status !== 'triage-skipped' || lookups.status !== 'triage-skipped' || candidates.requests.length || results.length) throw new Error("Skipped source has unexpected resolution evidence");
    return {requests: []};
  }
  if (!['reasoning', 'deep'].includes(gate.route) || lookups.status !== 'lookup-evidence-ready' || normalization.status !== 'normalization-proposed') throw new Error("Retained normalization and authorized lookups are required");
  const revision = lookups.indexed_revision;
  const sameRevision = (r: any) => r && ['generation', 'sequence', 'git_commit', 'configuration_digest'].every(k => r[k] === revision[k]);
  const pages = new Map<string, any>();
  const retain = (result: any) => {
    if (!sameRevision(result.indexed_revision) || result.status !== 'found' || result.found !== true || !result.page || typeof result.page.markdown !== 'string' || typeof result.page.content_hash !== 'string') throw new Error("A candidate page is missing or changed since the lookup");
    const p = result.page, existing = pages.get(p.slug);
    if (existing && existing.content_hash !== p.content_hash) throw new Error("Candidate page versions conflict");
    pages.set(p.slug, {slug: p.slug, type: p.type, title: p.title, aliases: p.aliases, markdown: p.markdown, content_hash: p.content_hash, links:p.links, original_links:p.original_links, metadata:p.metadata});
  };
  for (const item of lookups.entities) if (item.result.found) retain(item.result);
  if (results.length !== candidates.requests.length || new Set(results.map((x: any) => x.key)).size !== results.length) throw new Error("Candidate reads are incomplete or duplicated");
  for (const request of candidates.requests) {
    const result = results.find((x: any) => x.key === request.key)?.output;
    if (!result || result.page?.slug !== request.slug) throw new Error("Candidate read does not match the requested page");
    retain(result);
  }
  const entityLookups = lookups.entities.map((x: any) => ({...x.request, status: x.result.status, slugs: x.result.found ? [x.result.page.slug] : x.result.candidates.map((p: any) => p.slug)}));
  const sourceText = prepared.segments.map((s: any) => s.data.segment.text).join('');
  const requests = normalization.meetings.map((meeting: any) => {
    const searches = lookups.meeting_searches.filter((x: any) => x.request.key.startsWith(meeting.key + '-')).map((x: any) => ({...x.request, slugs: [...new Set(x.result.hits.map((p: any) => p.slug))]}));
    const relevant = entityLookups.filter((x: any) => x.type !== 'meeting' || x.name === meeting.title);
    const slugs = new Set([...relevant.flatMap((x: any) => x.slugs), ...searches.flatMap((x: any) => x.slugs)]);
    for (const slug of slugs) if (!pages.has(slug as string)) throw new Error("An identified candidate has not been read completely");
    const data = {source: prepared.source, raw_transcript_text: sourceText.slice(meeting.start, meeting.end), provisional_meeting: meeting,
      host_context: {source_complete: true, source_range: {start: meeting.start, end: meeting.end}, indexed_revision: revision,
        entity_lookups: relevant, meeting_searches: searches, pages: [...slugs].map(slug => pages.get(slug as string)), prior_gaps: normalization.gaps}};
    if (JSON.stringify(data).length > 150000) throw new Error("Complete identity and deduplication evidence exceeds the bound; do not truncate source or pages");
    return {key: meeting.key, prompt_path: prompts[gate.route], data};
  });
  return {requests};
} });
