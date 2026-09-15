import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any, context: any) {

 const {task,calls}=input.context,facts=input.facts;
 const reject=(feedback:string)=>({accepted:false,feedback});
 if(facts.source_identity!==task.source.identity||facts.source_version!==task.source.version)return reject('Completion must refer to this exact source identity and version.');
 if(facts.verification.length!==6||new Set(facts.verification.map((v:any)=>v.check)).size!==6)return reject('Run and report every adopted V1–V6 check on the saved pages.');
 const reads=new Map<string,any>(),writes:any[]=[],changed=new Set<string>();let lastWrite=-1;
 for(let i=0;i<calls.length;i++){
  const c=calls[i];if(c.error)continue;
  if(c.name==='oregano_brain_entity'&&c.output?.found===true&&c.output.status==='found')reads.set(c.output.page.slug,{...c.output,index:i});
  if(c.name==='oregano_brain_remember'&&['saved','unchanged'].includes(c.output?.status)){
   if(!['indexed','current_head_indexed'].includes(c.output.sync_status)||(c.output.status==='saved'&&!c.output.saved_commit))return reject('Reconcile the saved Git receipt and index before completing.');
   if(c.input?.provenance?.source_id!==task.source.identity||c.input.provenance.source_version!==task.source.version)return reject('A write is missing the exact source provenance.');
   writes.push(c);lastWrite=i;
   for(const path of c.output.changed_paths)changed.add(path.replace(/^brain\//,'').replace(/\.md$/,''));
  }
 }
 if(!writes.length)return reject('No saved knowledge receipt exists. Save the sourced pages before completing.');
 if(new Set(facts.pages).size!==facts.pages.length)return reject('Final page identities must be unique.');
 const required=new Set<string>([...changed,task.evidence.slug,...task.prior.requests.map((r:any)=>r.slug)]);
 for(const m of facts.meetings)for(const slug of [m.slug,...m.attendees,...m.entities])required.add(slug);
 if(task.source.kind==='meeting'&&!facts.meetings.length)return reject('A retained meeting needs its actual meeting page(s), with resolved or explicitly flagged attendees.');
 for(const slug of required){
  const page=reads.get(slug);
  if(!facts.pages.includes(slug)||!page?.page?.markdown||page.index<lastWrite||!page.indexed_revision)return reject('Read every saved/affected page after the final write and include it in completion: '+slug);
  const last=writes.filter(w=>w.input.changes.pages.some((p:any)=>p.path==='brain/'+slug+'.md')).at(-1);
  const expected=last?.input.changes.pages.find((p:any)=>p.path==='brain/'+slug+'.md');
  if(expected&&expected.markdown!==page.page.markdown)return reject('Saved content differs from the final write; reread and reconcile: '+slug);
 }
 for(const slug of facts.pages)if(!required.has(slug)&&!reads.has(slug))return reject('Completion contains an unread page: '+slug);
 const evidence=reads.get(task.evidence.slug)?.page.markdown;
 if(!evidence?.includes(JSON.stringify(task.source.identity))||!evidence.includes(JSON.stringify(task.source.version))||!evidence.includes(task.source.context.companyos_record_version))return reject('Retain exact source identity, version and original Record provenance on the evidence page.');
 for(const meeting of facts.meetings){
  const page=reads.get(meeting.slug).page.markdown;
  if(!page.includes('[['+task.evidence.slug+']]'))return reject('Meeting page must cite its internal original-source evidence: '+meeting.slug);
  for(const slug of [...meeting.attendees,...meeting.entities]){
   const entity=reads.get(slug).page.markdown;
   if(!page.includes('[['+slug+']]')||!entity.slice(entity.indexOf('<!-- timeline -->')).includes('[['+meeting.slug+']]'))return reject('Complete the meeting link and entity Timeline backlink: '+slug);
  }
 }
 return {accepted:true,feedback:''};

} });
