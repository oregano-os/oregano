import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,extraction,reads,directories}=input;
 if(gate.route==='skip'){if(reads.length||extraction.lookups.length)throw Error('Skip cannot have subject reads');return {targets:[],evidence:null,extraction:{}};}
 if(reads.length!==extraction.lookups.length||new Set(reads.map((r:any)=>r.key)).size!==reads.length)throw Error('Discussion identity read coverage is incomplete');
 if(!/^workflow:[a-f0-9]{64}$/.test(context.runId)||['person','company','concept','source'].some(k=>typeof directories[k]!=='string'||! /^[a-z][a-z0-9-]{0,39}$/.test(directories[k])))throw Error('Reviewed discussion identity and mappings required');
 const slugify=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,90).replace(/-$/,'');
 let revision:any=null;const targets:any[]=[];
 for(const lookup of extraction.lookups){const read=reads.find((r:any)=>r.key===lookup.key)?.output;
  if(!read?.indexed_revision||!['found','not_found'].includes(read.status)||(read.status==='found')!==read.found||(!read.found&&read.candidates?.length!==0))throw Error('Discussion identity is ambiguous or its complete read is unavailable');
  if(revision&&!['generation','sequence','git_commit','configuration_digest'].every(k=>revision[k]===read.indexed_revision[k]))throw Error('Discussion identity context changed across reads');revision=read.indexed_revision;
  const name=lookup.name,slug=read.found?read.page.slug:directories[lookup.type]+'/'+slugify(name);
  if((read.found&&read.page.type!==lookup.type)||!slug.startsWith(directories[lookup.type]+'/')||slug.endsWith('/')||slug.length>160)throw Error('Discussion target has the wrong type or path');
  const old=targets.find(t=>t.slug===slug);if(old){if(old.type!==lookup.type||(!old.existing&&old.name!==name))throw Error('Discussion identities collide');continue;}
  targets.push({key:lookup.key,name,type:lookup.type,slug,existing:read.found});
 }
 const source=prepared.source,slug=directories.source+'/import-'+context.runId.slice(9),quote=(v:any)=>JSON.stringify(v);
 targets.unshift({key:'discussion-evidence',name:'Imported discussion source',type:'source',slug,existing:false});
 const markdown='---\ntype: source\ntitle: "Imported discussion source"\nsource_identity: '+quote(source.identity)+'\nsource_version: '+quote(source.version)+'\nrecord_version_id: '+quote(source.context.companyos_record_version)+'\nsource_kind: discussion\n---\n\n# Imported discussion source\n\nThe complete original discussion is retained as the exact authorized Company Record version.\n\n[Original source]('+source.original_url.replace(/[()<>\s]/g,(s:string)=>encodeURIComponent(s))+')\n';
 return {targets,evidence:{slug,markdown},extraction:extraction.extraction};
}});
