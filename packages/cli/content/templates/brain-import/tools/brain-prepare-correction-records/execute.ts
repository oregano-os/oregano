import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,history,reads,source_directory}=input;
 if(reads.length!==history.requests.length||new Set(reads.map((r:any)=>r.key)).size!==reads.length)throw Error('Earlier page read coverage is incomplete');
 let revision:any=null;const pages=history.requests.map((request:any)=>{const read=reads.find((r:any)=>r.key===request.key)?.output;
  if(read?.status!=='found'||!read.found||read.page?.slug!==request.slug||!read.indexed_revision)throw Error('A prior affected page is unavailable; reconcile deletion explicitly');
  if(revision&&!['generation','sequence','git_commit','configuration_digest'].every(k=>revision[k]===read.indexed_revision[k]))throw Error('Earlier pages changed during correction reads');revision=read.indexed_revision;
  return {key:request.key,slug:request.slug,type:read.page.type,existing:true,read};});
 const requests:any[]=[],versions=new Set<string>();
 for(const page of pages.filter((p:any)=>p.type==='source')){
  const m=page.read.page.metadata;
  if(m.source_identity!==prepared.source.identity)continue;
  if(typeof m.source_version!=='string'||m.source_version===prepared.source.version||! /^[a-f0-9]{64}$/.test(m.record_version_id??''))throw Error('Earlier source lacks an exact immutable original reference');
  const links=page.read.page.markdown.match(/\[Original source\]\(([^)]+)\)/g)??[];
  if(links.length!==1)throw Error('Earlier source lacks its exact original link');
  const url=decodeURI(links[0].slice('[Original source]('.length,-1));
  if(!versions.has(m.record_version_id)){requests.push({key:'original-'+requests.length,identity:m.source_identity,version:m.source_version,record_version_id:m.record_version_id,original_url:url});versions.add(m.record_version_id);}
 }
 if(pages.length&&(!requests.length||!pages.some((p:any)=>p.type!=='source')))throw Error('Earlier knowledge requires complete source and subject coverage');
 if(!/^[a-z][a-z0-9-]{0,39}$/.test(source_directory)||!/^workflow:[a-f0-9]{64}$/.test(context.runId))throw Error('Reviewed correction identity required');
 const slug=source_directory+'/correction-'+context.runId.slice(9);
 return {requests,pages,evidence_slug:slug,evidence_reads:pages.length?[{key:'correction-evidence',slug}]:[]};

}});
