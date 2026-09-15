import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,results}=input;if(gate.route==='skip'){if(results.length)throw Error('Skipped discussion cannot have extraction');return {status:'triage-skipped',extraction:{},lookups:[]};}
 if(results.length!==1||results[0].key!=='discussion')throw Error('One complete discussion extraction is required');const value=JSON.parse(results[0].output.text);
 const text=(v:any,max=4000)=>typeof v==='string'&&v.length<=max;
 if(!value||typeof value!=='object'||Array.isArray(value)||!text(value.summary)||!value.summary.trim()||!text(value.filing)||!text(value.filing_reason)||!value.entities||!Array.isArray(value.entities.people)||!Array.isArray(value.entities.companies)||!Array.isArray(value.concepts)||!Array.isArray(value.takes)||value.takes.length>200)throw Error('Invalid adopted discussion extraction fields');
 for(const k of ['user_writing_quality','emotional_significance'])if(!Number.isFinite(value[k])||value[k]<0||value[k]>10)throw Error('Invalid original discussion score');
 for(const k of ['user_writing_excerpt','emotional_note','relationship_signal','era'])if(!text(value[k]))throw Error('Missing original discussion extraction field');
 if(typeof value.key_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.key_date)||new Date(value.key_date).toISOString().slice(0,10)!==value.key_date)throw Error('Discussion date must be explicit and valid');
 const original=prepared.segments.map((s:any)=>s.data.segment.text).join(''),normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
 if(value.user_writing_excerpt&&!normalize(original).includes(normalize(value.user_writing_excerpt)))throw Error('A discussion excerpt must match the original source');
 const lookups:any[]=[];
 for(const [type,entries] of [['person',value.entities.people],['company',value.entities.companies],['concept',value.concepts]] as any){
  if(entries.length>100)throw Error('Discussion identity coverage exceeds its bound');
  for(const e of entries){if(!e||!text(e.name,160)||!e.name.trim())throw Error('Invalid discussion identity');
   if(type==='person'&&(![null,undefined].includes(e.email)&&!text(e.email,300)||![null,undefined].includes(e.role)&&!text(e.role,2000)))throw Error('Invalid discussion person context');
   if(type==='company'&&!text(e.context))throw Error('Invalid discussion company context');if(type==='concept'&&!text(e.description))throw Error('Invalid discussion concept context');
   if(!lookups.some(x=>x.type===type&&x.name===e.name))lookups.push({key:'discussion-entity-'+(lookups.length+1),type,name:e.name});
  }
 }
 if(!lookups.length||lookups.length>100)throw Error('Retained discussion needs a bounded set of source-grounded primary subjects');
 for(const take of value.takes)if(!take||!text(take.holder,160)||!text(take.claim)||!Number.isFinite(take.confidence)||take.confidence<0||take.confidence>10)throw Error('Invalid attributed discussion claim');
 return {status:'extracted',extraction:value,lookups};
}});
