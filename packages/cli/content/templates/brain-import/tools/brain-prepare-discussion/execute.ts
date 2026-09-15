import {defineCompanyTool} from "@companyos/tool-sdk";
export default defineCompanyTool({async execute(input:any,context:any){

 const {prepared,gate,prompts}=input;if(prepared.source.kind!=='discussion'||prepared.source_complete!==true||gate.coverage_complete!==true)throw Error('Complete discussion triage is required');
 if(gate.route==='skip')return {requests:[]};if(!['reasoning','deep'].includes(gate.route))throw Error('Unsupported discussion route');
 let end=0,text='';for(const item of prepared.segments){const s=item.data.segment;if(s.start!==end||s.end-s.start!==s.text.length)throw Error('Discussion source coverage is incomplete');text+=s.text;end=s.end;}
 const data={source:prepared.source,source_text:text,triage:gate.items,host_context:{source_complete:true}};
 if(!text||JSON.stringify(data).length>150000)throw Error('Complete discussion exceeds the bounded extraction input');
 return {requests:[{key:'discussion',prompt_path:prompts[gate.route],data}]};
}});
