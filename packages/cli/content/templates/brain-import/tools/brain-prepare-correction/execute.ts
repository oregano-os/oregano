import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,history,results,evidence_reads,prompts}=input;
 if(results.length!==history.requests.length||new Set(results.map((r:any)=>r.key)).size!==results.length)throw Error('Earlier original coverage is incomplete');
 const originals=history.requests.map((request:any)=>{const result=results.find((r:any)=>r.key===request.key)?.output,v=result?.rows?.[0]?.values;
  if(result?.access_decision?.allowed!==true||result.next_cursor||result.rows?.length!==1||result.retained_version_id!==request.record_version_id||result.rows[0].source_version_id!==request.record_version_id||v?.complete!==true||v.identity!==prepared.source.identity||v.version!==request.version||decodeURI(v.original_url)!==request.original_url||typeof v.text!=='string'||!v.text.trim())throw Error('Earlier complete original version is unavailable');
  return {identity:v.identity,version:v.version,original_url:v.original_url,text:v.text,context:v.source_context??{}};});
 if(!history.pages.length){if(evidence_reads.length)throw Error('No prior knowledge requires no correction read');return {requests:[],targets:[],evidence:null,gate:{route:'skip',coverage_complete:true}};}
 const read=evidence_reads[0]?.output;
 if(evidence_reads.length!==1||read?.status!=='not_found'||read.found!==false||read.candidates?.length||!read.indexed_revision||history.pages.some((p:any)=>!['generation','sequence','git_commit','configuration_digest'].every(k=>p.read.indexed_revision[k]===read.indexed_revision[k])))throw Error('Correction evidence target collided or page context changed');
 const source=prepared.source,quote=(x:any)=>JSON.stringify(x),slug=history.evidence_slug;
 const markdown='---\ntype: source\ntitle: "Source correction evidence"\nsource_identity: '+quote(source.identity)+'\nsource_version: '+quote(source.version)+'\nrecord_version_id: '+quote(source.context.companyos_record_version)+'\nsource_kind: '+source.kind+'\n---\n\n# Source correction evidence\n\nCurrent original for the correction; prior versions remain historical evidence.\n\n[Original source]('+source.original_url.replace(/[()<>\s]/g,(s:string)=>encodeURIComponent(s))+')\n';
 const targets=[{key:'correction-evidence',slug,type:'source',existing:false,read},...history.pages.filter((p:any)=>p.type!=='source')];
 const requests=targets.filter((p:any)=>p.type!=='source').map((target:any)=>{
  const data={source,source_text:prepared.segments.map((s:any)=>s.data.segment.text).join(''),originals,
   host_context:{source_complete:true,target_page:{slug:target.slug,type:target.type,title:target.read.page.title},page_read:target.read,internal_evidence_page:slug,
    retained_evidence_slugs:history.pages.filter((p:any)=>p.type==='source').map((p:any)=>p.slug),correction_date:input.instant.slice(0,10)}};
  if(JSON.stringify(data).length>140000)throw Error('Complete correction context exceeds the bounded phase; retain all originals and use a reviewed segmented comparison');
  return {key:target.key,prompt_path:prompts[gate.route==='deep'?'deep':'reasoning'],data};});
 return {requests,targets,evidence:{slug,markdown},gate:{route:gate.route==='deep'?'deep':'reasoning',coverage_complete:true}};

}});
