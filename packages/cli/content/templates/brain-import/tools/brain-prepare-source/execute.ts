import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input) {
  const x = input as any;
  if (x.records.access_decision?.allowed !== true || x.records.next_cursor) throw new Error("Source Records read is incomplete or unauthorized");
  if (!Array.isArray(x.records.rows) || x.records.rows.length !== 1) throw new Error("Exactly one selected source version is required");
  const v = x.records.rows[0].values;
  if (!v || v.identity !== x.identity || v.version !== x.version || v.complete !== true || !['meeting', 'discussion'].includes(v.kind)) throw new Error("Source identity, version or complete coverage does not match");
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 2000000) throw new Error("Source text is absent or exceeds the bounded workflow capacity");
  const remote = typeof v.original_url === 'string' && /^https:\/\/[^\s@]+$/.test(v.original_url);
  const local = v.identity.startsWith('local:raw/') && typeof v.original_url === 'string' && /^file:\/\/\/[^\s?#]+$/.test(v.original_url);
  if ((!remote && !local) || typeof v.occurred_at !== 'string' || !Number.isFinite(Date.parse(v.occurred_at))) throw new Error("Source provenance is incomplete");
  const providerContext = v.source_context ?? {};
  if(!/^[a-f0-9]{64}$/.test(x.records.rows[0].source_version_id))throw new Error("The exact normalized source Record version is required");
  const context = {...providerContext,companyos_record_version:x.records.rows[0].source_version_id};
  if (typeof providerContext !== 'object' || providerContext===null || Array.isArray(providerContext) || JSON.stringify(providerContext).length > 20000 || JSON.stringify(context).length > 20100) throw new Error("Source context is malformed or exceeds the bounded workflow capacity");
  const source = {identity: v.identity, version: v.version, kind: v.kind, original_url: v.original_url, occurred_at: v.occurred_at, context};
  const segments: any[] = [];
  const boundary = (end: number) => end < v.text.length && /[\uD800-\uDBFF]/.test(v.text[end - 1]) && /[\uDC00-\uDFFF]/.test(v.text[end]) ? end - 1 : end;
  for (let start = 0; start < v.text.length;) {
    let end = boundary(Math.min(v.text.length, start + x.segment_characters));
    // Escaping can expand JSON. Retain all context and every source character.
    while (end > start && JSON.stringify({source, segment: {id: 'segment-1000', start, end, text: v.text.slice(start, end)}}).length > 100000) end = boundary(start + Math.floor((end - start) / 2));
    if (end <= start || segments.length >= 1000) throw new Error("Source segmentation cannot preserve complete coverage within bounds");
    const id = 'segment-' + String(segments.length + 1).padStart(4, '0');
    segments.push({key: id, data: {source, segment: {id, start, end, text: v.text.slice(start, end)}}}); start = end;
  }
  return {source, source_complete: true, expected_segments: segments.map(x => x.key), segments};
} });
