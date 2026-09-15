import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {normalization, entity_results, search_results} = input;
  const collect = (expected: any[], actual: any[]) => {
    if (expected.length !== actual.length || new Set(actual.map(x => x.key)).size !== actual.length) throw new Error("Brain lookup coverage is missing or duplicated");
    return expected.map(request => {
      const item = actual.find(x => x.key === request.key);
      if (!item || !item.output || !item.output.indexed_revision) throw new Error("Brain lookup receipt is missing");
      return {request, result: item.output};
    });
  };
  const entities = collect(normalization.lookups, entity_results), searches = collect(normalization.meeting_searches, search_results);
  if (normalization.status === 'triage-skipped') {
    if (entities.length || searches.length) throw new Error("A skipped source cannot claim interpretation lookups");
    return {status: 'triage-skipped', entities: [], meeting_searches: [], indexed_revision: null};
  }
  let revision: any = null;
  for (const item of [...entities, ...searches]) {
    if (revision && JSON.stringify(item.result.indexed_revision) !== JSON.stringify(revision)) throw new Error("Brain changed across lookup receipts; fresh consistent context is required");
    revision = item.result.indexed_revision;
  }
  for (const {result} of entities) {
    if (!['found', 'not_found', 'ambiguous'].includes(result.status) || (result.status === 'found') !== result.found
      || (result.found && (!result.page || typeof result.page.markdown !== 'string' || typeof result.page.content_hash !== 'string'))
      || (!result.found && !Array.isArray(result.candidates))) throw new Error("Brain entity lookup is malformed");
  }
  for (const {result} of searches) if (result.status !== 'ok' || !Array.isArray(result.hits) || result.has_more !== false || result.omitted_neighbors !== false) throw new Error("Meeting deduplication search is incomplete");
  if (!revision) throw new Error("Retained meeting normalization has no read evidence");
  return {status: 'lookup-evidence-ready', entities, meeting_searches: searches, indexed_revision: revision};
} });
