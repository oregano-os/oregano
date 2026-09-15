import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,preparation,drafts}=input;
 if(drafts.pages.length!==preparation.requests.length||new Set(drafts.pages.map((p:any)=>p.key)).size!==drafts.pages.length)throw Error('Discussion drafts do not cover every subject');
 const normalize=(s:string)=>s.replace(/\s+/g,' ').trim(),source=prepared.segments.map((s:any)=>s.data.segment.text).join('');
 for(const page of drafts.pages){
  const request=preparation.requests.find((r:any)=>r.key===page.key);if(!request||page.slug!==request.data.host_context.target_entity.slug||page.type!==request.data.host_context.target_entity.type)throw Error('Discussion draft differs from its target');
  const prior=request.data.host_context.page_read.page?.markdown??'';const quotes=page.markdown.match(/(?:^>[^\n]*(?:\n|$))+/gm)??[];
  for(const quote of quotes){const text=normalize(quote.split('\n').map((line:string)=>line.replace(/^>\s?/, '')).join(' '));if(text&&!normalize(source).includes(text)&&!normalize(prior).includes(text))throw Error('A discussion quotation is absent from source and prior page evidence');}
 }
 return {prepared,gate,preparation,meeting_drafts:{status:drafts.status,pages:[]},entity_drafts:drafts,verification:{status:gate.route==='skip'?'triage-skipped':'discussion-drafts-checked'}};
}});
