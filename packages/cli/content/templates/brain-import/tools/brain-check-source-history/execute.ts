import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {

 const {prepared,resolution,history,results}=input;
 if(results.length!==history.requests.length||new Set(results.map((x:any)=>x.key)).size!==results.length)throw new Error('Original source result coverage is incomplete');
 const currentText=prepared.segments.map((s:any)=>s.data.segment.text).join('');
 const canonical=(url:string)=>decodeURI(url.split('#')[0]);
 const meetings=resolution.meetings.map((meeting:any)=>{
  if(meeting.source_comparison!=='required')return meeting;
  const refs=history.references.filter((r:any)=>r.meeting_keys.includes(meeting.key));
  if(!refs.length)throw new Error('Matched meeting lacks complete original source comparison');
  const sources:any[]=[],seen=new Set<string>();
  for(const ref of refs){
   let source=prepared.source,text=currentText;
   if(ref.query_key){
    const response=results.find((x:any)=>x.key===ref.query_key)?.output;
    if(response?.access_decision?.allowed!==true||response.next_cursor||response.rows?.length!==1)throw new Error('Earlier exact source version is unavailable or its Records read is incomplete');
    if(ref.record_version_id&&(response.retained_version_id!==ref.record_version_id||response.rows[0].source_version_id!==ref.record_version_id))throw new Error('Earlier Record result differs from its retained version reference');
    const v=response.rows[0].values;
    if(v.complete!==true||(ref.metadata.source_identity&&v.identity!==ref.metadata.source_identity)||v.kind!=='meeting'||v.version!==ref.version||canonical(v.original_url)!==ref.original_url||typeof v.text!=='string'||!v.text.trim())throw new Error('Earlier original source identity or completeness is not proven');
    source={identity:v.identity,version:v.version,kind:v.kind,original_url:v.original_url,occurred_at:v.occurred_at,context:v.source_context??{}};text=v.text;
   }
   const segments=ref.metadata.meeting_segments;
   if(segments!==undefined){
    if(!Array.isArray(segments))throw new Error('Earlier meeting segmentation is invalid');
    const ranges=segments.filter((s:any)=>s.slug===meeting.dedup.existing_slug);
    if(ranges.length!==1||!Number.isSafeInteger(ranges[0].start)||!Number.isSafeInteger(ranges[0].end)||ranges[0].start<0||ranges[0].end<=ranges[0].start||ranges[0].end>text.length)throw new Error('Earlier meeting requires its exact retained source segment');
    text=text.slice(ranges[0].start,ranges[0].end);
   }
   const id=JSON.stringify([source.identity,source.version]);
   if(!seen.has(id)){sources.push({source,text,evidence_slug:ref.slug});seen.add(id);}
  }
  const currentChunk=currentText.slice(meeting.start,meeting.end);
  const incoming={source:prepared.source,text:currentChunk,evidence_slug:null};
  const same=sources.find((s:any)=>s.source.identity===prepared.source.identity&&s.source.version===prepared.source.version);
  if(same&&same.text!==currentChunk)throw new Error('The same source version has incompatible meeting boundaries');
  const grounding=same?sources:[incoming,...sources];
  const active=grounding.filter((s:any)=>s.source.identity!==prepared.source.identity||s.source.version===prepared.source.version);
  const richest=active.reduce((a:any,b:any)=>b.text.length>a.text.length?b:a);
  for(const item of grounding)item.historical=item.source.identity===prepared.source.identity&&item.source.version!==prepared.source.version;
  return {...meeting,source_comparison:'compared',grounding_sources:grounding,richer_source:{identity:richest.source.identity,version:richest.source.version},
   retained_evidence_slugs:refs.map((r:any)=>r.slug)};
 });
 return {status:resolution.status,meetings};
} });
