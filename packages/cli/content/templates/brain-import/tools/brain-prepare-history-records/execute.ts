import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {

 const {prepared,resolution,history,reads}=input;
 if(reads.length!==history.requests.length||new Set(reads.map((x:any)=>x.key)).size!==reads.length)throw new Error('Earlier evidence page coverage is incomplete');
 const canonical=(url:string)=>decodeURI(url.split('#')[0]);
 const requests:any[]=[],references:any[]=[];
 for(const request of history.requests){
  const receipt=reads.find((x:any)=>x.key===request.key)?.output,page=receipt?.page;
  if(receipt?.status!=='found'||receipt.found!==true||page?.slug!==request.slug||page.type!=='source')throw new Error('Earlier evidence page is absent or has the wrong type');
  for(const key of request.meeting_keys){
   const meeting=resolution.meetings.find((m:any)=>m.key===key);
   if(!meeting||!['generation','sequence','git_commit','configuration_digest'].every(k=>meeting.indexed_revision[k]===receipt.indexed_revision?.[k]))throw new Error('Earlier evidence changed since meeting resolution');
  }
  const urls=[...new Set(page.original_links.map(canonical))];
  if(urls.length!==1)throw new Error('Evidence page needs one unambiguous original source');
  const metadata=page.metadata??{};
  const legacyHash=page.markdown.match(/Original byte SHA-256:\s*\x60([a-f0-9]{64})\x60/)?.[1];
  const version=metadata.source_version??legacyHash;
  if(typeof version!=='string'||!version||version.length>256)throw new Error('Earlier source version is unavailable; do not compare only summaries');
  const record_version_id=metadata.record_version_id??null;
  if(record_version_id!==null&&(typeof record_version_id!=='string'||!/^[a-f0-9]{64}$/.test(record_version_id)))throw new Error('Earlier normalized Record version is invalid');
  const same=canonical(prepared.source.original_url)===urls[0]&&prepared.source.version===version;
  const original_url=urls[0];
  const queryKey=same?null:'original-'+(requests.length+1);
  if(queryKey)requests.push({key:queryKey,original_url,version,record_version_id});
  references.push({key:request.key,slug:page.slug,meeting_keys:request.meeting_keys,original_url:urls[0],version,query_key:queryKey,
   record_version_id,metadata,markdown:page.markdown,content_hash:page.content_hash});
 }
 return {requests,references};
} });
