import type { CompanyRecordsStore } from '../state-store/records.ts';
import type { RecordAccessSubject, RecordObjectVersion, RecordQuery } from './contracts.ts';
import type { CompanyRecordsRegistry } from './registry.ts';
import { recordDigest, recordVersionId } from './identity.ts';
import { projectRecord } from './projection.ts';
import { filterRecordRows } from './query.ts';
import { sha256 } from '../runtime/canonical.ts';

/** Exact retained observation, projected through the current authorized declaration. */
export async function readRetainedRecordVersion(args: {
  instanceId: string; registry: CompanyRecordsRegistry; store: CompanyRecordsStore;
  query: RecordQuery; subject: RecordAccessSubject;
}) {
  const {instanceId,registry,store,query,subject}=args, versionId=query.source_version_id;
  if(typeof versionId!=='string'||!/^[a-f0-9]{64}$/.test(versionId))throw new Error('An exact normalized Record version ID is required');
  if(query.cursor!==undefined||query.all_pages!==undefined||query.require_scan_started_after!==undefined||query.require_synced_through!==undefined)
    throw new Error('A retained version read cannot claim current scan, completeness or pagination');
  if(query.limit!==undefined&&(!Number.isInteger(query.limit)||query.limit<1||query.limit>200))throw new Error('Invalid Record page limit');
  const projection=registry.projection(query.projection_id), sourceIds=registry.projectionSourceIds(projection.id);
  if(!sourceIds.length||sourceIds.length>100)throw new Error('Retained version queries require 1 to 100 contributing sources');
  // Evaluate filters and all current source policies before any storage read.
  filterRecordRows(projection,query.filters??{},[]);
  for(const id of sourceIds){
    const source=registry.source(id);registry.assertSourceInstance(id,instanceId);
    if(source.record_type!==projection.record_type)throw new Error('Projection names a source of another record type');
    if(subject.status!=='active'||!source.access.read_groups.some(group=>subject.group_ids.includes(group)))throw new Error('Retained version access denied by current source policy');
  }
  const versions:RecordObjectVersion[]=[];
  for(const sourceId of sourceIds){
    const v=await store.getObjectVersion(instanceId,sourceId,versionId);if(!v)continue;
    const sourceDigest=registry.sourceDigest(sourceId),bound=registry.sourceBindingDigest(sourceId)!==undefined;
    if(v.instance_id!==instanceId||v.source_id!==sourceId||v.version_id!==versionId||v.record_type!==projection.record_type
      ||(bound&&v.source_receipt.source_digest!==sourceDigest))throw new Error('Retained Record escaped its Instance or source generation');
    const digest=recordDigest({deleted:v.deleted,values:v.values,...(bound?{source_digest:sourceDigest}:{})});
    if(v.digest!==digest||recordVersionId(sourceId,v.object_id,digest)!==versionId)throw new Error('Retained Record content differs from its immutable identity');
    if(!Number.isFinite(Date.parse(v.observed_at)))throw new Error('Invalid retained observation timestamp');
    versions.push(v);
  }
  if(versions.length>1)throw new Error('Retained Record version is ambiguous');
  const rows=filterRecordRows(projection,query.filters??{},versions.flatMap(version=>{
    const row=projectRecord({projection,version,projectedAt:version.observed_at});return row?[row]:[];
  }));
  if(JSON.stringify(rows).length>2_500_000)throw new Error('Retained Record exceeds the bounded response size');
  const observedAt=versions[0]?.observed_at;
  return {rows,snapshot_id:sha256({projection,source_digests:sourceIds.map(id=>[id,registry.sourceDigest(id)]),source_version_id:versionId,filters:query.filters??{},rows}),
    source_proofs:[],retained_version_id:versionId,...(observedAt?{observed_at:observedAt}:{})};
}
