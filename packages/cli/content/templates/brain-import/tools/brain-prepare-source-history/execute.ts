import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {

 const {resolution,requests,source_directory}=input, selected=new Map<string,any>();
 for(const meeting of resolution.meetings){
  if(meeting.source_comparison!=='required')continue;
  const request=requests.find((r:any)=>r.key===meeting.key);
  const page=request?.data.host_context.pages.find((p:any)=>p.slug===meeting.dedup.existing_slug);
  if(!page || !Array.isArray(page.links))throw new Error('Complete matched meeting link evidence is missing');
  const slugs=[...new Set(page.links.map((link:any)=>link.target).filter((slug:any)=>typeof slug==='string'&&slug.startsWith(source_directory+'/')))];
  if(!slugs.length)throw new Error('Matched meeting has no retained original-source evidence page');
  for(const slug of slugs){
   if(!selected.has(slug as string))selected.set(slug as string,{key:'history-'+(selected.size+1),slug,meeting_keys:[]});
   selected.get(slug as string).meeting_keys.push(meeting.key);
  }
 }
 if(selected.size>200)throw new Error('Earlier-source coverage exceeds the bounded plan');
 return {requests:[...selected.values()]};
} });
