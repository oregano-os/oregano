import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {plan,reads}=input;
 if(reads.length!==plan.requests.length||new Set(reads.map((x:any)=>x.key)).size!==reads.length)throw new Error('Final Brain read-back coverage is incomplete');
 if(plan.route==='skip'&&!plan.receipts.length){
  if(reads.length||plan.receipts.length)throw new Error('Skipped source cannot have write receipts');
  return {status:'skipped',source_identity:plan.source.identity,source_version:plan.source.version,route:plan.route,pages:[],receipts:[],indexed_revision:null};
 }
 if(!plan.requests.length||!plan.receipts.length)throw new Error('Ingestion requires actual saved and indexed pages');
 let revision:any=null;
 const pages=plan.requests.map((request:any)=>{
  const result=reads.find((x:any)=>x.key===request.key)?.output;
  if(result?.status!=='found'||result.found!==true||result.page?.slug!==request.slug||result.page.markdown!==request.markdown||!result.indexed_revision)throw new Error('Saved Brain content differs from the verified draft; reconcile before completion');
  if(revision&&!['generation','sequence','git_commit','configuration_digest'].every(k=>revision[k]===result.indexed_revision[k]))throw new Error('Brain changed during final read-back; refresh before completion');
  revision=result.indexed_revision;
  return {slug:result.page.slug,content_hash:result.page.content_hash};
 });
 return {status:plan.route==='skip'?'reconciled':'ingested',source_identity:plan.source.identity,source_version:plan.source.version,route:plan.route,pages,receipts:plan.receipts,indexed_revision:revision};
}});
