import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,preparation,meeting_drafts,entity_drafts,verification}=input;
 const reconciliation=input.procedure==='reconciliation',action=reconciliation?'reconcile-batch-':'import-batch-';
 if(gate.route==='skip'){
  if(gate.coverage_complete!==true||verification.status!=='triage-skipped'||preparation.targets.length||meeting_drafts.pages.length||entity_drafts.pages.length)throw new Error('Skip requires complete checked source coverage and zero drafts');
  return {requests:[],pages:[],source:prepared.source,route:gate.route};
 }
 if(prepared.source_complete!==true||gate.coverage_complete!==true||(reconciliation?(verification.status!=='reconciliation-verified'||verification.reports.length!==preparation.requests.length):prepared.source.kind==='meeting'?(verification.status!=='verified'||verification.reports.length!==preparation.requests.length):verification.status!=='discussion-drafts-checked'))throw new Error('Every retained meeting must pass complete verification before writes');
 if(!/^workflow:[a-f0-9]{64}$/.test(context.runId))throw new Error('Stable source-version Workflow identity is required');
 const sourceTarget=preparation.targets.find((t:any)=>t.slug===preparation.evidence?.slug);
 if(!sourceTarget||sourceTarget.existing||sourceTarget.read.status!=='not_found')throw new Error('New exact source evidence target is required');
 const pages=[{slug:preparation.evidence.slug,type:'source',expected_content_hash:null,markdown:preparation.evidence.markdown},...entity_drafts.pages,...meeting_drafts.pages];
 if(pages.length!==preparation.targets.length||new Set(pages.map((p:any)=>p.slug)).size!==pages.length)throw new Error('Write pages do not cover every planned target exactly once');
 const revision=sourceTarget.read.indexed_revision.git_commit;
 for(const page of pages){
  const target=preparation.targets.find((t:any)=>t.slug===page.slug&&t.type===page.type);
  if(!target||target.read.indexed_revision.git_commit!==revision||page.expected_content_hash!==(target.read.found?target.read.page.content_hash:null)||typeof page.markdown!=='string'||page.markdown.length>100000)throw new Error('Write page differs from its exact target read or exceeds the page bound');
  if(target.read.found){
   const before=target.read.page.timeline.trim(),after=page.markdown.split('<!-- timeline -->')[1]??'';
   if(before&&!after.includes(before))throw new Error('Retain the complete earlier Timeline before adding source events');
  }
 }
 // Only Takes holders are hard cross-page dependencies. Other unresolved links
 // remain visible until later batches, while source evidence is written first.
 const deps=new Map<string,string[]>();
 for(const page of pages){
  const start=page.markdown.indexOf('<!--- gbrain:takes:begin -->'),end=page.markdown.indexOf('<!--- gbrain:takes:end -->');
  const holders:string[]=[];
  if(start>=0){
   if(end<start)throw new Error('A partial Takes fence cannot enter a write batch');
   const lines=page.markdown.slice(start+'<!--- gbrain:takes:begin -->'.length,end).split('\n').filter((s:string)=>s.trim());
   for(const line of lines.slice(2)){
    const cells:string[]=[];let cell='',escaped=false;
    for(const c of line.trim().slice(1,-1)){if(escaped){cell+=c;escaped=false;}else if(c==='\\')escaped=true;else if(c==='|'){cells.push(cell.trim());cell='';}else cell+=c;}cells.push(cell.trim());
    if(cells.length!==7)throw new Error('A malformed Takes row cannot enter a write batch');
    const holder=cells[3],target=preparation.targets.find((t:any)=>t.slug===holder);
    if(target&&!target.existing&&holder!==page.slug)holders.push(holder);
   }
  }
  deps.set(page.slug,[...new Set([...holders,...(page.type==='source'?[]:[pages[0].slug])])]);
 }
 const groups:any[][]=[],done=new Set<string>();
 while(done.size<pages.length){
  const group:any[]=[];
  for(const page of pages){
   if(done.has(page.slug))continue;
   const closure=new Set<string>();
   const add=(slug:string)=>{if(done.has(slug)||closure.has(slug))return;closure.add(slug);for(const dep of deps.get(slug)??[])add(dep);};add(page.slug);
   const extra=pages.filter((p:any)=>closure.has(p.slug)&&!group.includes(p));
   if(group.length+extra.length>16||[...group,...extra].reduce((n:number,p:any)=>n+p.markdown.length,0)>400000){if(!group.length)throw new Error('An atomic Takes dependency group exceeds the standard Brain write bound');continue;}
   group.push(...extra);for(const p of extra)done.add(p.slug);
  }
  if(!group.length)throw new Error('No complete bounded write group can advance');groups.push(group);
 }
 const requests=groups.map((group:any[],index:number)=>({key:'batch-'+(index+1),changes:{expected_revision:revision,pages:group.map(p=>({path:'brain/'+p.slug+'.md',expected_content_hash:p.expected_content_hash,markdown:p.markdown}))},
  provenance:{source_id:prepared.source.identity,source_version:prepared.source.version,action:action+(index+1),evidence:[preparation.evidence.slug]},operation_key:context.runId+':'+action+(index+1)}));
 return {requests,pages,source:prepared.source,route:gate.route};
}});
