import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {requests,results}=input;
 if(results.length!==requests.length||new Set(results.map((r:any)=>r.key)).size!==results.length)throw Error('Correction verification coverage is incomplete');
 const reports=requests.map((request:any)=>{let report:any;try{report=JSON.parse(results.find((r:any)=>r.key===request.key)?.output?.text);}catch{throw Error('Correction requires a complete verification result');}
  if(Object.keys(report).sort().join(',')!=='evidence,gaps,repairs,verdict'||report.verdict!=='pass'||typeof report.evidence!=='string'||!report.evidence.trim()||!Array.isArray(report.gaps)||report.gaps.some((g:any)=>typeof g!=='string')||!Array.isArray(report.repairs)||report.repairs.length)throw Error('Correction verification blocked or requires repairs');return {key:request.key,...report};});
 return {status:requests.length?'reconciliation-verified':'triage-skipped',reports};

}});
