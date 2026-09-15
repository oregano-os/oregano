import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input:any) {
  const {prepared,gate,meeting_preparation:preparation,meeting_drafts:drafts,prompts}=input;
  if (drafts.status==='triage-skipped') {
    if (preparation.requests.length || preparation.targets.length || drafts.pages.length) throw new Error("Skipped source has unexpected page drafts");
    return {requests:[]};
  }
  if (prepared.source_complete!==true || gate.coverage_complete!==true || !['reasoning','deep'].includes(gate.route) || drafts.status!=='drafts-prepared') throw new Error("Complete source and checked meeting drafts are required");
  if (drafts.pages.length!==preparation.requests.length || new Set(drafts.pages.map((p:any)=>p.slug)).size!==drafts.pages.length) throw new Error("Meeting draft coverage is incomplete or duplicated");
  const meetings=preparation.requests.map((request:any)=>{
    const page=drafts.pages.find((p:any)=>p.key===request.key);
    if (!page || page.slug!==request.data.host_context.target_page.slug || page.type!=='meeting') throw new Error("Meeting draft does not match its authorized target");
    return {key:request.key,slug:page.slug,markdown:page.markdown,normalization:request.data.normalization,
      entity_targets:request.data.host_context.entity_targets,prior_source_evidence:[{source:request.data.grounding_source,text:request.data.raw_transcript_text},...(request.data.additional_source_evidence??[])].filter((s:any)=>s.source.identity!==prepared.source.identity||s.source.version!==prepared.source.version),retained_evidence_slugs:request.data.host_context.retained_evidence_slugs};
  });
  const targets=preparation.targets.filter((target:any)=>['person','company','concept'].includes(target.type));
  if (targets.length>200 || new Set(targets.map((x:any)=>x.slug)).size!==targets.length) throw new Error("Entity targets must be unique and bounded");
  const text=prepared.segments.map((x:any)=>x.data.segment.text).join('');
  const requests=targets.map((target:any)=>{
    const related=meetings.filter((meeting:any)=>meeting.entity_targets.some((x:any)=>x.slug===target.slug));
    if (!related.length || !target.read?.indexed_revision || (target.existing ? target.read.status!=='found'||target.read.page?.slug!==target.slug : target.read.status!=='not_found'||target.read.found!==false||target.read.candidates?.length!==0)) throw new Error("Entity lacks complete meeting context or an exact page-read receipt");
    const entity={slug:target.slug,type:target.type,name:target.name};
    const data={source:prepared.source,raw_transcript_text:text,meetings:related,
      host_context:{source_complete:true,target_entity:entity,target_page:{...entity,title:entity.name},page_read:target.read,
        internal_evidence_page:preparation.evidence.slug,required_backlinks:related.map((x:any)=>x.slug)}};
    if (JSON.stringify(data).length>150000) throw new Error("Complete entity evidence exceeds the bound; do not truncate source or prior page");
    return {key:target.key,prompt_path:prompts[gate.route],data};
  });
  return {requests};
} });
