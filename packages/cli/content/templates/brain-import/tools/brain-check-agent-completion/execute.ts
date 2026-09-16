import { defineCompanyTool } from "@companyos/tool-sdk";
const hasLink=(markdown:string,slug:string)=>markdown.includes('[['+slug+']]')||new RegExp('\\[\\['+slug+'\\|[^\\]\\n]{1,160}\\]\\]').test(markdown);
export default defineCompanyTool({ async execute(input: any, context: any) {

 const {task,calls}=input.context,facts=input.facts;
 const reject=(feedback:string)=>({accepted:false,feedback:feedback.length<=2000?feedback:feedback.slice(0,1900)+' Additional repairs remain; repeat the check after these corrections.'});
 if(facts.source_identity!==task.source.identity||facts.source_version!==task.source.version)return reject('Completion must refer to this exact source identity and version.');
 const references=[...facts.pages,...facts.meetings.flatMap((m:any)=>[m.slug,...m.attendees,...m.entities])];
 if(references.some((slug:any)=>typeof slug!=='string'||! /^[a-z][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,119}$/.test(slug)))return reject('Completion pages, meeting attendees and entities must use canonical Brain page slugs from successful reads (page.slug), never display names. Keep the existing read receipts and replace the names in completion with those canonical slugs.');
 if(facts.verification.length!==6||new Set(facts.verification.map((v:any)=>v.check)).size!==6)return reject('Run and report every adopted V1–V6 check on the saved pages.');
 if(facts.status==='skipped'){
  if(task.prior.requests.length||facts.pages.length||facts.meetings.length||calls.some((c:any)=>c.name==='oregano_brain_remember'))return reject('A notability skip requires no prior knowledge and no attempted writes. Reconcile saved or prior pages instead.');
  if(!facts.gaps.some((gap:string)=>gap.trim())||facts.verification.some((v:any)=>v.status!=='not-applicable'))return reject('Explain the notability skip and mark saved-page checks not applicable.');
  return {accepted:true,feedback:''};
 }
 const reads=new Map<string,any>(),writes:any[]=[],changed=new Set<string>(),lastWrites=new Map<string,number>();
 for(let i=0;i<calls.length;i++){
  const c=calls[i];if(c.error)continue;
  if(c.name==='oregano_brain_entity'&&c.output?.found===true&&c.output.status==='found')reads.set(c.output.page.slug,{...c.output,index:i});
  if(c.name==='oregano_brain_remember'&&['saved','unchanged'].includes(c.output?.status)){
   if(!['indexed','current_head_indexed'].includes(c.output.sync_status)||(c.output.status==='saved'&&!c.output.saved_commit))return reject('Reconcile the saved Git receipt and index before completing.');
   if(c.input?.provenance?.source_id!==task.source.identity||c.input.provenance.source_version!==task.source.version)return reject('A write is missing the exact source provenance.');
   writes.push(c);
   for(const page of c.input.changes.pages)lastWrites.set(page.path.replace(/^brain\//,'').replace(/\.md$/,''),i);
   for(const path of c.output.changed_paths)changed.add(path.replace(/^brain\//,'').replace(/\.md$/,''));
  }
 }
 if(!writes.length)return reject('No saved knowledge receipt exists. Save the sourced pages before completing.');
 if(new Set(facts.pages).size!==facts.pages.length)return reject('Final page identities must be unique.');
 const required=new Set<string>([...changed,task.evidence.slug,...task.prior.requests.map((r:any)=>r.slug)]);
 for(const m of facts.meetings)for(const slug of [m.slug,...m.attendees,...m.entities])required.add(slug);
 if(task.source.kind==='meeting'&&!facts.meetings.length)return reject('A retained meeting needs its actual meeting page(s), with resolved or explicitly flagged attendees.');
 if(facts.meetings.length&&facts.verification.some((v:any)=>v.status!=='passed'&&!(v.check==='V6'&&v.status==='flagged-uncertainty')))return reject('Apply the actual adopted V1–V6 checklist to retained meetings; only unresolved sequence uncertainty may remain flagged.');
 const missingReads:string[]=[],mismatched:string[]=[],unresolved:string[]=[];
 for(const slug of required){
  const page=reads.get(slug);
  if(!facts.pages.includes(slug)||!page?.page?.markdown||page.index<(lastWrites.get(slug)??-1)||!page.indexed_revision){missingReads.push(slug);continue;}
  const last=writes.filter(w=>w.input.changes.pages.some((p:any)=>p.path==='brain/'+slug+'.md')).at(-1);
  const expected=last?.input.changes.pages.find((p:any)=>p.path==='brain/'+slug+'.md');
  if(expected&&expected.markdown!==page.page.markdown)mismatched.push(slug);
  // The Core index reports actual unresolved links; an Agent cannot waive a
  // broken source reference by describing it as cosmetic in its completion.
  for(const link of page.outgoing??[])if(!link.resolved)unresolved.push(slug+' -> '+link.target);
 }
 if(missingReads.length)return reject('Read every affected page after its own final write and include all of these in completion: '+missingReads.join(', '));
 if(mismatched.length)return reject('Saved content differs from the final write; reread and reconcile: '+mismatched.join(', '));
 if(unresolved.length)return reject('Repair unresolved saved-page links, then reread affected pages: '+[...new Set(unresolved)].join(', '));
 for(const slug of facts.pages)if(!required.has(slug)&&!reads.has(slug))return reject('Completion contains an unread page: '+slug);
 const evidence=reads.get(task.evidence.slug)?.page.markdown;
 if(!evidence?.includes(JSON.stringify(task.source.identity))||!evidence.includes(JSON.stringify(task.source.version))||!evidence.includes(task.source.context.companyos_record_version))return reject('Retain exact source identity, version and original Record provenance on the evidence page.');
 const missingBacklinks:string[]=[];
 for(const meeting of facts.meetings){
  const page=reads.get(meeting.slug).page.markdown;
  for(const heading of ['Summary','Key Decisions','Action Items','Notable Quotes'])if(!new RegExp('^## '+heading+'\\s*$','m').test(page))return reject('V1: restore the adopted meeting section '+heading+' on '+meeting.slug);
  if(!hasLink(page,task.evidence.slug))return reject('Meeting page must cite its internal original-source evidence: '+meeting.slug);
  for(const slug of [...meeting.attendees,...meeting.entities]){
   const entity=reads.get(slug).page.markdown;
   const referenced=reads.get(slug).page;
   // Cross-references to evidence/other meetings are not person/company
   // attendance entries and must not force Timeline sections into those pages.
   const needsTimeline=!['meeting','source'].includes(referenced.type);
   if(!hasLink(page,slug)||(needsTimeline&&!hasLink(entity.slice(entity.indexOf('<!-- timeline -->')),meeting.slug)))missingBacklinks.push(slug);
  }
 }
 if(missingBacklinks.length)return reject('Complete the meeting links and entity Timeline backlinks: '+[...new Set(missingBacklinks)].join(', '));
 return {accepted:true,feedback:''};

} });
