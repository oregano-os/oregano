import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input:any) {
  const {prepared,gate,plan,reads,resolution_requests,prompts} = input;
  if (plan.status === 'triage-skipped') {
    if (reads.length || plan.targets.length) throw new Error("Skipped source has unexpected page reads");
    return {requests:[], targets:[], evidence:null};
  }
  if (reads.length !== plan.targets.length || new Set(reads.map((x:any)=>x.key)).size !== reads.length) throw new Error("Every planned page requires a complete read");
  const targets=plan.targets.map((target:any)=>{
    const read=reads.find((x:any)=>x.key===target.key)?.output;
    if (!read?.indexed_revision || (target.existing ? read.status!=='found'||read.page?.slug!==target.slug : read.status!=='not_found'||read.found!==false||read.candidates?.length!==0)) throw new Error("Page target changed or a new page path collides; reconcile before drafting");
    const revision=plan.meetings[0].indexed_revision;
    if (!['generation','sequence','git_commit','configuration_digest'].every(k=>read.indexed_revision[k]===revision[k])) throw new Error("Brain changed before page preparation; refreshed resolution is required");
    return {...target,read};
  });
  const text=prepared.segments.map((x:any)=>x.data.segment.text).join('');
  const requests=plan.meetings.map((meeting:any)=>{
    const target=targets.find((x:any)=>x.slug===meeting.target_slug),resolution=resolution_requests.find((x:any)=>x.key===meeting.key);
    if (!resolution) throw new Error("Meeting resolution context is missing");
    const grounding=meeting.grounding_sources??[{source:prepared.source,text:text.slice(meeting.start,meeting.end),evidence_slug:null}];
    const richest=grounding.find((s:any)=>s.source.identity===meeting.richer_source?.identity&&s.source.version===meeting.richer_source?.version)??grounding[0];
    const {grounding_sources:ignored,...normalization}=meeting;
    const data={source:prepared.source,raw_transcript_text:richest.text,additional_source_evidence:grounding.filter((s:any)=>s!==richest),grounding_source:richest.source,normalization,
      host_context:{source_complete:true,retained_evidence_slugs:meeting.retained_evidence_slugs??[],internal_evidence_page:plan.evidence.slug,target_page:{slug:target.slug,type:target.type,title:target.name},page_read:target.read,
        entity_targets:targets.filter((x:any)=>meeting.entity_slugs.includes(x.slug)).map((x:any)=>({slug:x.slug,type:x.type,name:x.name})),
        authorized_identity_context:resolution.data.host_context,sibling_meetings:plan.meetings.map((x:any)=>({slug:x.target_slug,title:x.title,start:x.start,end:x.end}))}};
    if (JSON.stringify(data).length>150000) throw new Error("Complete meeting-page evidence exceeds the bound; do not truncate");
    return {key:meeting.key,prompt_path:prompts[gate.route],data};
  });
  return {requests,targets,evidence:plan.evidence};
} });
