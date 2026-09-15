import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input:any) {
  const {prepared,gate,meeting_preparation:preparation,meeting_drafts:meetings,entity_preparation:entities,entity_drafts:entityDrafts,prompts}=input;
  if (gate.route==='skip') {
    if (preparation.requests.length || meetings.pages.length || entities.requests.length || entityDrafts.pages.length) throw new Error("Skipped source has unexpected verification drafts");
    return {requests:[]};
  }
  if (prepared.source_complete!==true || gate.coverage_complete!==true || meetings.status!=='drafts-prepared' || entityDrafts.status!=='drafts-prepared') throw new Error("Complete source and checked drafts are required before verification");
  const allRequests=[...preparation.requests,...entities.requests],pages=[...meetings.pages,...entityDrafts.pages];
  if (pages.length!==allRequests.length || new Set(pages.map((p:any)=>p.slug)).size!==pages.length || new Set(allRequests.map((r:any)=>r.data.host_context.target_page.slug)).size!==allRequests.length) throw new Error("Draft verification coverage is incomplete or duplicated");
  for (const request of allRequests) if (!pages.some((p:any)=>p.key===request.key&&p.slug===request.data.host_context.target_page.slug&&p.type===request.data.host_context.target_page.type)) throw new Error("Draft verification target differs from its checked request");
  const text=prepared.segments.map((x:any)=>x.data.segment.text).join('');
  const words=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const requests=preparation.requests.map((request:any)=>{
    const host=request.data.host_context,meeting=meetings.pages.find((p:any)=>p.key===request.key);
    const required=host.entity_targets.map((x:any)=>x.slug);
    const related=entityDrafts.pages.filter((p:any)=>required.includes(p.slug));
    if (related.length!==required.length) throw new Error("Meeting verification is missing a confirmed attendee or subject page");
    for (const slug of required) if (!meeting.markdown.includes('[['+slug+']]')) throw new Error("Meeting draft lacks a resolved attendee or subject link");
    // Compare every complete blockquote. Attribution belongs outside the quote in the bound page serialization.
    const sourceWords=[request.data.raw_transcript_text,...(request.data.additional_source_evidence??[]).map((s:any)=>s.text)].map((t:string)=>' '+words(t)+' ');
    const quotes:string[]=[];let block:string[]=[],fence:string|null=null;
    const flush=()=>{if(block.length){quotes.push(block.join('\n'));block=[];}};
    for(const line of meeting.markdown.split(/\r?\n/)){
      const marker=line.match(/^\s*(`{3,}|~{3,})/);
      if(marker){flush();if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;continue;}
      if(fence)continue;
      if(/^\s*>/.test(line))block.push(line.replace(/^\s*>\s?/,''));else flush();
    }flush();
    for(const quote of quotes)if(!words(quote)||!sourceWords.some((t:string)=>t.includes(' '+words(quote)+' ')))throw new Error("Meeting contains an ungrounded complete blockquote; restore verbatim source wording before verification");
    const data={source:prepared.source,raw_transcript_text:text,meeting:{...meeting,normalization:request.data.normalization},entity_pages:related,
      source_evidence_page:preparation.evidence,prior_source_evidence:[{source:request.data.grounding_source,text:request.data.raw_transcript_text},...(request.data.additional_source_evidence??[])].filter((s:any)=>s.source.identity!==prepared.source.identity||s.source.version!==prepared.source.version),prior_pages:preparation.targets.filter((t:any)=>t.slug===meeting.slug||required.includes(t.slug)).map((t:any)=>({slug:t.slug,read:t.read})),
      host_context:{source_complete:true,required_entity_slugs:required,grounded_blockquotes:quotes.length,prior_gaps:request.data.normalization.unresolved??[],
        sibling_meetings:preparation.requests.map((r:any)=>({slug:r.data.host_context.target_page.slug,normalization:r.data.normalization}))}};
    if(JSON.stringify(data).length>150000)throw new Error("Complete verification evidence exceeds the bound; do not truncate source, drafts or prior pages");
    return {key:request.key,prompt_path:prompts[gate.route],data};
  });
  return {requests};
} });
