import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any, context: any) {

 const {prepared,gate,history,directories}=input;
 if(prepared.source_complete!==true||gate.coverage_complete!==true)throw Error('Complete source and triage are required');
 const source=prepared.source;
 if([source.identity,source.version].some(v=>typeof v!=='string'||v.length>256))throw Error('Source provenance exceeds the write contract');
 let text='',end=0;
 for(const entry of prepared.segments){const part=entry.data.segment;if(part.start!==end||part.end!==part.start+part.text.length)throw Error('Source segments are not complete and ordered');text+=part.text;end=part.end;}
 if(end!==source.context.companyos_retained_source.characters)throw Error('Full original coverage is required');
 if(Object.keys(directories).sort().join(',')!=='company,concept,meeting,person,source'||Object.values(directories).some((v:any)=>typeof v!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(v)))throw Error('Reviewed directory mappings are required');
 const slug=directories.source+'/import-'+source.context.companyos_record_version;
 const markdown='---\ntype: source\ntitle: "Imported source version"\nsource_identity: '+JSON.stringify(source.identity)+'\nsource_version: '+JSON.stringify(source.version)+'\nrecord_version_id: '+JSON.stringify(source.context.companyos_record_version)+'\nsource_kind: '+JSON.stringify(source.kind)+'\n---\n\n# Imported source version\n\nComplete original text and participants are retained in the authorized Company Record.\n\n[Original source]('+source.original_url.replace(/[()<>\s]/g,(c:string)=>encodeURIComponent(c))+')\n';
 const route=gate.route==='skip'&&history.requests.length?'reasoning':gate.route;
 const provenance={source_id:source.identity,source_version:source.version,action:'incremental-import',evidence:[slug]};
 return {route,model_profile:gate.route==='deep'?'deep':'reasoning',provenance,task:{source,original_text:text,triage:gate,prior:history,directories,evidence:{slug,markdown},provenance}};

} });
