import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any, context: any) {

 const {task,route,execution}=input;
 if(route==='skip'){
  if(execution!==null||task.prior.requests.length)throw Error('A skip cannot discard prior derived knowledge');
  return {status:'skipped',source_identity:task.source.identity,source_version:task.source.version,route,pages:[],receipts:[],indexed_revision:null,verification:[],gaps:[]};
 }
 if(!execution?.result||!Array.isArray(execution.calls))throw Error('Completed Agent evidence is required');
 const result=execution.result,reads=new Map<string,any>(),receipts:any[]=[];
 for(const c of execution.calls){if(c.error)continue;if(c.name==='oregano_brain_entity'&&c.output?.found===true)reads.set(c.output.page.slug,c.output);if(c.name==='oregano_brain_remember'&&['saved','unchanged'].includes(c.output?.status))receipts.push(c.output);}
 if(!receipts.length||result.source_identity!==task.source.identity||result.source_version!==task.source.version)throw Error('Saved source-version outcome is missing');
 const pages=result.pages.map((slug:string)=>{const page=reads.get(slug);if(!page)throw Error('Missing final read');return {slug,content_hash:page.page.content_hash};});
 return {status:result.status,source_identity:task.source.identity,source_version:task.source.version,route,pages,receipts,indexed_revision:reads.get(result.pages.at(-1))?.indexed_revision??null,verification:result.verification,gaps:result.gaps};

} });
