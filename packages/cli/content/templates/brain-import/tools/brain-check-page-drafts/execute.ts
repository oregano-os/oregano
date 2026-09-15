import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input:any) {
  const {requests,results,route}=input;
  if (route==='skip' && (requests.length || results.length)) throw new Error("Skipped source cannot produce page drafts");
  if (requests.length!==results.length||new Set(results.map((x:any)=>x.key)).size!==results.length) throw new Error("Page draft coverage is incomplete or duplicated");
  const pages=requests.map((request:any)=>{
    const markdown=results.find((x:any)=>x.key===request.key)?.output?.text;
    if (typeof markdown!=='string'||markdown.length>100000||!/^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(markdown)||!markdown.includes('<!-- timeline -->')) throw new Error("Expected a complete Markdown page with frontmatter and a sourced Timeline");
    const host=request.data.host_context;
    if (!markdown.includes('[['+host.internal_evidence_page+']]')) throw new Error("Page draft lacks the exact retained internal evidence reference");
    for (const slug of host.retained_evidence_slugs??[]) if(!markdown.includes('[['+slug+']]'))throw new Error('Merged page dropped an earlier original-source evidence link');
    for (const slug of host.required_backlinks ?? []) if (!markdown.slice(markdown.indexOf('<!-- timeline -->')).includes('[['+slug+']]')) throw new Error("Entity draft lacks a required meeting Timeline backlink");
    return {key:request.key,slug:host.target_page.slug,type:host.target_page.type,expected_content_hash:host.page_read.found?host.page_read.page.content_hash:null,markdown};
  });
  return {status:route==='skip'?'triage-skipped':'drafts-prepared',pages};
} });
