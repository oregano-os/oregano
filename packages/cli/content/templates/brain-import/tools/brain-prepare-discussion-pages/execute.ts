import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,plan,reads,prompts}=input;
 if(reads.length!==plan.targets.length||new Set(reads.map((r:any)=>r.key)).size!==reads.length)throw Error('Discussion page read coverage is incomplete');
 if(gate.route==='skip')return {requests:[],targets:[],evidence:null};
 let revision:any=null;const targets=plan.targets.map((target:any)=>{const read=reads.find((r:any)=>r.key===target.key)?.output;
  if(!read?.indexed_revision||(target.existing?(read.status!=='found'||!read.found||read.page?.slug!==target.slug||read.page.type!==target.type):(read.status!=='not_found'||read.found!==false||read.candidates?.length!==0)))throw Error('Discussion page collided or its exact read is unavailable');
  if(revision&&!['generation','sequence','git_commit','configuration_digest'].every(k=>revision[k]===read.indexed_revision[k]))throw Error('Discussion page reads changed');revision=read.indexed_revision;return {...target,read};});
 const source_text=prepared.segments.map((s:any)=>s.data.segment.text).join('');
 const requests=targets.filter((t:any)=>t.type!=='source').map((target:any)=>{
  const entity={slug:target.slug,type:target.type,name:target.name};const data={source:prepared.source,source_text,extraction:plan.extraction,
   host_context:{source_complete:true,target_entity:entity,target_page:{...entity,title:entity.name},page_read:target.read,internal_evidence_page:plan.evidence.slug,related_entities:targets.filter((t:any)=>t.type!=='source').map((t:any)=>({slug:t.slug,name:t.name,type:t.type})),required_backlinks:[plan.evidence.slug]}};
  if(JSON.stringify(data).length>150000)throw Error('Complete discussion page context exceeds its bound');return {key:target.key,prompt_path:prompts[gate.route],data};});
 return {requests,targets,evidence:plan.evidence};
}});
