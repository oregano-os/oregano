import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {preparation,drafts,prompts}=input;
 if(drafts.pages.length!==preparation.requests.length||new Set(drafts.pages.map((p:any)=>p.key)).size!==drafts.pages.length)throw Error('Correction drafts lack complete affected page coverage');
 const rows=(text:string)=>{
  const block=text.match(/<!--- gbrain:takes:begin -->([\s\S]*?)<!--- gbrain:takes:end -->/);if(!block)return [];
  const lines=block[1].split('\n').filter(s=>s.trim()).slice(2);
  return lines.map(line=>{const cells:string[]=[];let cell='',escaped=false;for(const c of line.trim().slice(1,-1)){if(escaped){cell+='\\'+c;escaped=false;}else if(c==='\\')escaped=true;else if(c==='|'){cells.push(cell.trim());cell='';}else cell+=c;}cells.push(cell.trim());if(cells.length!==7)throw Error('Malformed prior or corrected Takes table');return cells;});};
 const requests=preparation.requests.map((request:any)=>{
  const draft=drafts.pages.find((p:any)=>p.key===request.key),before=request.data.host_context.page_read.page,markdown=draft.markdown;
  const front=(s:string)=>s.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n/)?.[0];
  if(draft.slug!==before.slug||draft.type!==before.type||front(markdown)!==front(before.markdown)||!markdown.split('<!-- timeline -->')[1]?.includes(before.timeline.trim()))throw Error('Correction changed page identity, metadata or earlier Timeline');
  const oldRows=rows(before.markdown),newRows=rows(markdown);
  if(oldRows.length!==newRows.length)throw Error('Correction must preserve every stable Take row and cannot add new claims');
  for(const old of oldRows){const next=newRows.find(n=>n[0]===old[0]);if(!next||old.some((cell,i)=>i!==1&&next[i]!==cell)||![old[1],'~~'+old[1]+'~~'].includes(next[1]))throw Error('Correction changed a stable Take instead of retaining or retiring it');
   if(next[1]!==old[1]&&!request.data.host_context.retained_evidence_slugs.some((slug:string)=>old[6].includes('[['+slug+']]')))throw Error('Correction retired a Take from an unrelated source');}
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim(),sources=[request.data.source_text,before.markdown,...request.data.originals.map((x:any)=>x.text)].map(normalize);
  for(const quote of markdown.match(/(?:^>[^\n]*(?:\n|$))+/gm)??[]){const text=normalize(quote.split('\n').map((line:string)=>line.replace(/^>\s?/, '')).join(' '));if(text&&!sources.some(s=>s.includes(text)))throw Error('Correction quotation is absent from complete evidence');}
  const data={...request.data,proposed_markdown:markdown};if(JSON.stringify(data).length>150000)throw Error('Complete correction verification exceeds its context bound');
  return {key:request.key,prompt_path:prompts[preparation.gate.route],data};});
 return {requests};

}});
