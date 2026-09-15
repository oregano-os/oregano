import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input:any) {
  const {requests,results,route}=input;
  if(requests.length!==results.length||new Set(results.map((x:any)=>x.key)).size!==results.length)throw new Error("Verification coverage is incomplete or duplicated");
  if(route==='skip'){
    if(requests.length)throw new Error("Skipped source has unexpected verification calls");
    return {status:'triage-skipped',reports:[]};
  }
  if(!requests.length)throw new Error("Retained source requires meeting verification");
  const keys=(x:any,expected:string)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===expected;
  const strings=(x:any)=>Array.isArray(x)&&x.length<=100&&x.every((s:any)=>typeof s==='string'&&s.trim().length>0&&s.length<=2000);
  const reports=requests.map((request:any)=>{
    const raw=results.find((x:any)=>x.key===request.key)?.output?.text;
    if(typeof raw!=='string'||raw.length>20000)throw new Error("Verification result is absent or oversized");
    let report:any;try{report=JSON.parse(raw);}catch{throw new Error("Verification requires plain complete JSON");}
    if(!keys(report,'checks,gaps,repairs')||!Array.isArray(report.checks)||report.checks.length!==6||!strings(report.gaps)||!strings(report.repairs))throw new Error("Verification must retain all checklist verdicts, gaps and repairs");
    if(report.checks.map((c:any)=>c?.id).sort().join(',')!=='V1,V2,V3,V4,V5,V6')throw new Error("Verification must cover V1 through V6 exactly once");
    for(const check of report.checks)if(!keys(check,'evidence,id,verdict')||!['pass','block'].includes(check.verdict)||typeof check.evidence!=='string'||!check.evidence.trim()||check.evidence.length>4000)throw new Error("Each checklist item requires an explicit supported pass or block; no implicit waive");
    for(const gap of request.data.host_context.prior_gaps)if(!report.gaps.includes(gap))throw new Error("Verification silently dropped an unresolved source gap");
    const failed=report.checks.filter((c:any)=>c.verdict!=='pass').map((c:any)=>c.id);
    if(failed.length||report.repairs.length)throw new Error("Meeting verification blocked before writes: "+failed.join(',')+"; required repairs: "+report.repairs.length);
    return {key:request.key,meeting_slug:request.data.meeting.slug,...report};
  });
  return {status:'verified',reports};
} });
