import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CompanyRecordsRegistry} from '../../records/registry.ts';
import {CompanyRecordsService} from '../../records/service.ts';
import {InMemoryCompanyRecordsStore} from '../../records/memory-store.ts';
import {validateJsonSchemaValue} from '../../capabilities/validation.ts';
import {RECORD_QUERY_INPUT_SCHEMA,RECORD_QUERY_OUTPUT_SCHEMA} from '../../records/query-schema.ts';
import type {CompanyRecordSourceDeclaration,CompanyRecordProjectionDeclaration,RecordQuery} from '../../records/contracts.ts';
import type {CompanyRecordSourceBinding} from '../../records/source-connector.ts';
const source:CompanyRecordSourceDeclaration={schema_version:1,id:'synthetic-items',record_type:'synthetic-record',connection:'connections/synthetic.md',resource_binding:'synthetic-resource',delivery:'poll',identity:{source_field:'id'},fields:[{target:'title',source:'title',value_type:'string',required:true},{target:'visible',source:'visible',value_type:'boolean',required:true},{target:'private',source:'private',value_type:'string'}],access:{read_groups:['team'],write_roles:[]}};
const projection:CompanyRecordProjectionDeclaration={schema_version:1,id:'synthetic-view',record_type:source.record_type,source_ids:[source.id],selection:{visible:true},fields:[{name:'title',path:'title'}],access:{read_groups:['team']},freshness:{max_age_minutes:60},materialization:{mode:'database-view'}};
const subject={principal_id:'synthetic:reader',status:'active' as const,roles:[],group_ids:['team']},instant='2030-02-01T10:00:00.000Z';
const binding:CompanyRecordSourceBinding={schema_version:1,instance_id:'synthetic-instance',source_id:source.id,resource_binding:source.resource_binding,connector:'synthetic/source',connector_version:'1.0.0',secret_ref:'env:SYNTHETIC_SECRET',qualification:{receipt_ref:'instance:synthetic/qualification',digest:'a'.repeat(64)},configuration:{resource:'synthetic-a'}};
function fixture({store=new InMemoryCompanyRecordsStore(),selected=source,view=projection,instanceId='synthetic-instance',bound=false,resource='synthetic-a'}={}){
 const registry=new CompanyRecordsRegistry();registry.registerSource(selected);registry.registerProjection(view);
 if(bound)registry.bindSource({...binding,instance_id:instanceId,configuration:{resource}},{kind:'synthetic-qualified'});
 const service=new CompanyRecordsService({instanceId,registry,store,now:()=>new Date(instant)});
 const ingest=async(id:string,title:string,visible=true,deleted=false)=>{const r=await service.ingest({event:{source_id:source.id,event_id:id,object_id:'one',kind:'updated',observed_at:instant,receipt:{}},raw:{id:'one',title,visible,private:'not exposed'},deleted});return r.version!.version_id;};
 const query=(version:string|null,options:Partial<RecordQuery>={})=>service.query({subject,query:{projection_id:view.id,source_version_id:version,...options}});
 return{service,registry,store,ingest,query};
}
test('retained version reads preserve the earlier observation after edits and deletion without freshness claims',async()=>{
 const h=fixture(),old=await h.ingest('first','Earlier statement');await h.ingest('second','Corrected statement');
 assert.equal((await h.query(null)).rows[0]!.values.title,'Corrected statement');
 const first=await h.query(old);assert.equal(first.rows[0]!.values.title,'Earlier statement');assert.deepEqual(Object.keys(first.rows[0]!.values),['title']);
 assert.equal(first.retained_version_id,old);assert.equal(first.observed_at,instant);assert.equal(first.fresh_until,instant);assert.deepEqual(first.source_proofs,[]);assert.equal(first.synced_through,undefined);
 const deleted=await h.ingest('third','Withdrawn',true,true);assert.equal((await h.query(null)).rows.length,0);assert.equal((await h.query(deleted)).rows.length,0);
 assert.equal((await h.query(old)).snapshot_id,first.snapshot_id);assert.equal((await h.query('f'.repeat(64))).rows.length,0);
 assert.equal(validateJsonSchemaValue(RECORD_QUERY_OUTPUT_SCHEMA,first).length,0);
});
test('retained version reads enforce current projection fields, selection and exact filters',async()=>{
 const h=fixture(),old=await h.ingest('first','Earlier statement'),excluded=await h.ingest('hidden','Hidden',false);
 assert.equal((await h.query(excluded)).rows.length,0);assert.equal((await h.query(old,{filters:{title:'Other'}})).rows.length,0);
 assert.equal((await h.query(old,{filters:{title:'Earlier statement'}})).rows.length,1);await assert.rejects(h.query(old,{filters:{private:'not exposed'}}));
 const restricted=fixture({store:h.store,view:{...projection,selection:{visible:false}}});assert.equal((await restricted.query(old)).rows.length,0);
});
test('retained reads authorize the projection and current source before storage',async()=>{
 const h=fixture(),old=await h.ingest('first','Earlier statement');let reads=0;const get=h.store.getObjectVersion.bind(h.store);h.store.getObjectVersion=async(...a)=>{reads++;return get(...a);};
 await assert.rejects(h.service.query({subject:{...subject,status:'inactive'},query:{projection_id:projection.id,source_version_id:old}}));assert.equal(reads,0);
 const denied=fixture({store:h.store,selected:{...source,access:{...source.access,read_groups:['restricted']}}});await assert.rejects(denied.query(old),/source policy/);assert.equal(reads,0);
 assert.equal(h.store.accessDecisions.at(-1)?.allowed,true,'Source access remains required after a successful projection grant');
});
test('retained reads preserve Instance and immutable binding-generation isolation after restart',async()=>{
 const h=fixture({bound:true}),old=await h.ingest('first','Earlier statement');assert.equal((await h.query(old)).rows.length,1);
 assert.equal((await fixture({store:h.store,bound:true}).query(old)).rows.length,1);
 assert.equal((await fixture({store:h.store,bound:true,resource:'synthetic-b'}).query(old)).rows.length,0);
 assert.equal((await fixture({store:h.store,bound:true,instanceId:'other-instance'}).query(old)).rows.length,0);
 const get=h.store.getObjectVersion.bind(h.store);h.store.getObjectVersion=async(...a)=>{const v=await get(...a);return v?{...v,source_receipt:{}}:v;};
 await assert.rejects(h.query(old),/generation/);
});
test('retained reads reject modified content and unrelated origin before returning data',async()=>{
 for(const change of [{instance_id:'foreign-instance'},{source_id:'foreign-source'},{values:{title:'Tampered',visible:true}}]){
  const h=fixture(),old=await h.ingest('first','Earlier statement'),get=h.store.getObjectVersion.bind(h.store);h.store.getObjectVersion=async(...a)=>{const v=await get(...a);return v?{...v,...change}:v;};
  await assert.rejects(h.query(old),/escaped|immutable/);
 }
});
test('retained reads reject incompatible modes and oversized output instead of truncating',async()=>{
 const h=fixture(),old=await h.ingest('first','Earlier statement');
 for(const options of [{cursor:'cursor'},{all_pages:false},{all_pages:true},{require_synced_through:instant},{require_scan_started_after:instant},{limit:0}])await assert.rejects(h.query(old,options));
 for(const source_version_id of ['', 'provider-version', 'a'.repeat(63)]){assert.ok(validateJsonSchemaValue(RECORD_QUERY_INPUT_SCHEMA,{projection_id:projection.id,source_version_id}).length);await assert.rejects(h.query(source_version_id));}
 const large=await h.ingest('large','x'.repeat(2_500_001));await assert.rejects(h.query(large),/bounded response/);
});
