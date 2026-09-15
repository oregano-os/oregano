import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const history=await context.capabilities.call('evidence.query',{kind:'workflows',references:[input.workflow_id],from:input.history_from,to:input.cutoff,limit:100,
  match_fields:{source_identity:input.identity},include_feedback:false,step_ids:['finish-import','finish-discussion','finish-skip']}) as any;
 if(history.coverage.complete!==true)throw Error('Complete retained source-run evidence is required before source processing');
 const prior_runs:string[]=[],prior_skipped_versions:string[]=[],slugs=new Set<string>();
 for(const run of history.items){
  if(run.id===context.runId||run.workflow_id!==input.workflow_id||run.fields.source_identity!==input.identity)throw Error('Earlier source run identity is inconsistent');
  if(run.status==='cancelled'&&run.fields.source_version===input.version&&run.source_restart?.successorRunId===context.runId){prior_runs.push(run.id);continue;}
  if(run.fields.source_version===input.version)throw Error('An unchanged completed source must reuse its retained run');
  if(run.status!=='done')throw Error('Finish or reconcile the earlier source-version run before opening another version');
  const step=run.steps['finish-discussion']??run.steps['finish-import']??run.steps['finish-skip'],result=step?.output;
  if(step?.status!=='succeeded'||!result||result.source_identity!==input.identity||result.source_version!==run.fields.source_version)throw Error('Earlier source completion has no exact final outcome');
  if(!Array.isArray(result.pages)||!Array.isArray(result.receipts))throw Error('Earlier outcome lacks retained page and effect evidence');
  if(result.status==='skipped'){if(result.pages.length||result.receipts.length)throw Error('Earlier skip has unexpected writes');prior_skipped_versions.push(result.source_version);}
  else {
   if(!['ingested','reconciled'].includes(result.status)||!result.pages.length||!result.receipts.length)throw Error('Earlier knowledge has no complete write outcome');
   for(const page of result.pages){if(typeof page.slug!=='string'||! /^[a-z0-9-]+\/[a-z0-9-]+$/.test(page.slug))throw Error('Earlier outcome has an invalid page identity');slugs.add(page.slug);}
  }
  prior_runs.push(run.id);
 }
 if(slugs.size>199)throw Error('Prior source page coverage exceeds the bounded correction plan');
 return {status:slugs.size?'reconciliation-required':'no-prior-knowledge',prior_runs,prior_skipped_versions,requests:[...slugs].sort().map((slug,i)=>({key:'prior-'+i,slug}))};

}});
