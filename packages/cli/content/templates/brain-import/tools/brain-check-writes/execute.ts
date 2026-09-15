import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {plan,results}=input;
 if(results.length!==plan.requests.length||new Set(results.map((x:any)=>x.key)).size!==results.length)throw new Error('Write receipt coverage is incomplete');
 const receipts=plan.requests.map((request:any)=>{
  const result=results.find((x:any)=>x.key===request.key)?.output;
  if(!result||!['saved','unchanged'].includes(result.status)||!['indexed','current_head_indexed'].includes(result.sync_status)||!result.indexed_revision||result.status==='saved'&&!result.saved_commit)throw new Error('Git and indexing must finish before read-back');
  const paths=request.changes.pages.map((p:any)=>p.path);
  if(!Array.isArray(result.changed_paths)||result.changed_paths.some((path:string)=>!paths.includes(path)))throw new Error('Write receipt changed an unplanned page');
  return {key:request.key,...result};
 });
 const pages=new Map<string,any>();
 for(const read of input.retained_reads??[]){if(read.read?.status!=='found'||read.slug!==read.read.page?.slug)throw Error('Retained correction evidence lacks its exact page read');pages.set(read.slug,{slug:read.slug,markdown:read.read.page.markdown});}
 if(input.prior){if(input.prior.source.identity!==plan.source.identity||input.prior.source.version!==plan.source.version)throw Error('Correction outcome belongs to another source version');for(const page of input.prior.requests)pages.set(page.slug,page);}
 for(const page of plan.pages)pages.set(page.slug,page);
 const allReceipts=[...(input.prior?.receipts??[]),...receipts];if(pages.size>200||allReceipts.length>200)throw Error('Combined correction read-back exceeds its bound');
 return {requests:[...pages.values()].map((p:any,i:number)=>({key:'readback-'+(i+1),slug:p.slug,markdown:p.markdown})),receipts:allReceipts,source:plan.source,route:plan.route};
}});
