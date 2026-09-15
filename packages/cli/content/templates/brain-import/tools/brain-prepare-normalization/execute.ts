import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {prepared, gate, prompts} = input;
  if (prepared.source_complete !== true || gate.coverage_complete !== true) throw new Error("Complete triage and source evidence are required");
  if (gate.route === 'skip') return {requests: []};
  if (!['reasoning', 'deep'].includes(gate.route) || prepared.source.kind !== 'meeting') throw new Error("This phase requires a retained meeting route");
  let text = '', end = 0;
  for (const item of prepared.segments) {
    const s = item.data.segment;
    if (s.start !== end || s.end - s.start !== s.text.length || JSON.stringify(item.data.source) !== JSON.stringify(prepared.source)) throw new Error("Source segmentation does not retain one complete version");
    text += s.text; end = s.end;
  }
  if (!text.length || prepared.segments.length !== prepared.expected_segments.length || prepared.segments.some((s: any, i: number) => s.key !== prepared.expected_segments[i])) throw new Error("Source segmentation is incomplete");
  const data = {source: prepared.source, raw_transcript_text: text, triage: gate.items,
    host_context: {source_complete: true, identity_status: 'provisional-until-authorized-brain-lookups', source_characters: text.length}};
  if (JSON.stringify(data).length > 150000) throw new Error("Complete normalization evidence exceeds the bound; do not truncate or declare ingestion complete");
  return {requests: [{key: 'source', prompt_path: prompts[gate.route], data}]};
} });
