import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any, context: any) {

 const {task,route,execution}=input;
 if(route==='skip'){
  if(execution!==null||task.prior.requests.length)throw Error('A skip cannot discard prior derived knowledge');
  return {status:'skipped',source_identity:task.source.identity,source_version:task.source.version,route,pages:[],receipts:[],indexed_revision:null,verification:[],gaps:[]};
 }
 if(!execution?.result||!Array.isArray(execution.calls))throw Error('Completed Agent evidence is required');
 // Text completion records what the Agent reported, not a server quality verdict.
 if(typeof execution.result.text==='string'){
  const report=execution.result.text;if(!report.trim())throw Error('A final Agent report is required');
  const pages=new Map<string,any>(task.prior.requests.map((p:any)=>[p.slug,{slug:p.slug}])),receipts:any[]=[];
  let attempted=false,indexed:any=null;
  for(const call of execution.calls){
   if(call.name!=='oregano_brain_remember')continue;
   attempted=true;if(call.error)continue;
   const write=call.output;
   if(!['saved','unchanged'].includes(write?.status))continue;
   if(call.input?.provenance?.source_id!==task.source.identity||call.input?.provenance?.source_version!==task.source.version)throw Error('Write provenance does not match the source task');
   if(!['indexed','current_head_indexed'].includes(write.sync_status)||!write.indexed_revision)throw Error('Reconcile the retained Git/index operation before recording its outcome');
   if(write.status==='saved'&&!write.saved_commit)throw Error('Missing durable Git write receipt');
   receipts.push(write);indexed=write.indexed_revision;
   for(const page of write.page_results??[]){
    if(!/^brain\/[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(page.path)||! /^[a-f0-9]{64}$/.test(page.content_hash))throw Error('Invalid retained page receipt');
    const slug=page.path.slice(6,-3);pages.set(slug,{slug,content_hash:page.content_hash});
   }
  }
  if(attempted&&!receipts.length)throw Error('All attempted writes failed; a final report is not a write receipt');
  return {status:'processed',source_identity:task.source.identity,source_version:task.source.version,route,pages:[...pages.values()],receipts,indexed_revision:indexed,
   verification:[],gaps:[],verification_mode:'agent-skill',agent_report:report};
 }
 const result=execution.result,reads=new Map<string,any>(),receipts:any[]=[];
 if(result.status==='skipped'){
  if(task.prior.requests.length||result.pages.length||result.meetings.length||execution.calls.some((c:any)=>c.name==='oregano_brain_remember')||!result.gaps.length
   ||result.source_identity!==task.source.identity||result.source_version!==task.source.version)throw Error('A notability skip cannot discard source identity or attempted/prior knowledge');
  return {status:'skipped',source_identity:task.source.identity,source_version:task.source.version,route,pages:[],receipts:[],indexed_revision:null,verification:result.verification,gaps:result.gaps};
 }
 for(const c of execution.calls){if(c.error)continue;if(c.name==='oregano_brain_entity'&&c.output?.found===true)reads.set(c.output.page.slug,c.output);if(c.name==='oregano_brain_remember'&&['saved','unchanged'].includes(c.output?.status))receipts.push(c.output);}
 if(!receipts.length||result.source_identity!==task.source.identity||result.source_version!==task.source.version)throw Error('Saved source-version outcome is missing');
 const pages=result.pages.map((slug:string)=>{const page=reads.get(slug);if(!page)throw Error('Missing final read');return {slug,content_hash:page.page.content_hash};});
 return {status:result.status,source_identity:task.source.identity,source_version:task.source.version,route,pages,receipts,indexed_revision:reads.get(result.pages.at(-1))?.indexed_revision??null,verification:result.verification,gaps:result.gaps};

} });
