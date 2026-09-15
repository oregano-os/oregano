import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any, context: any) {
  const {prepared, resolution, directories} = input;
  if (resolution.status === 'triage-skipped') return {status:'triage-skipped', targets:[], meetings:[], evidence:null};
  if (prepared.source_complete !== true || resolution.status !== 'resolution-reviewed') throw new Error("Complete source and reviewed resolution are required");
  if (Object.keys(directories).sort().join(',') !== 'company,concept,meeting,person,source' || Object.values(directories).some((x: any) => typeof x !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(x))) throw new Error("Reviewed page directory mappings are required");
  if (!/^workflow:[a-f0-9]{64}$/.test(context.runId)) throw new Error("A durable Workflow source-version identity is required");
  const targets:any[] = [], meetings:any[] = [];
  const slugify = (value:string) => {
    const result = value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,90).replace(/-$/,'');
    if (!result) throw new Error("A new page needs a representable reviewed name");
    return result;
  };
  const target = (type:string, name:string, existing:string|null, override?:string) => {
    const slug = existing ?? override ?? directories[type] + '/' + slugify(name);
    if (!slug.startsWith(directories[type] + '/') || slug.length > 160) throw new Error("Resolved page does not match the reviewed directory");
    const old = targets.find(x => x.slug === slug);
    if (old) {
      if (old.type !== type || old.existing !== (existing !== null) || (!old.existing && old.name !== name)) throw new Error("Distinct new identities collide at the same page path");
      return old;
    }
    const next = {key:'target-' + (targets.length+1),slug,type,name,existing:existing !== null};targets.push(next);return next;
  };
  const evidenceSlug = directories.source + '/import-' + context.runId.slice('workflow:'.length);
  target('source','Imported source version',null,evidenceSlug);
  for (const meeting of resolution.meetings) {
    if (meeting.source_comparison === 'required') throw new Error("Existing meeting matches require complete earlier source comparison before page preparation");
    const mt = target('meeting',meeting.title,meeting.dedup.existing_slug,directories.meeting + '/' + meeting.date + '-' + slugify(meeting.title));
    if (meetings.some(x => x.target_slug === mt.slug)) throw new Error("Separate source meetings collide at one page path");
    const entityTargets = new Set<string>();
    for (const attendee of meeting.attendees) if (attendee.name !== null) entityTargets.add(target('person',attendee.name,attendee.existing_slug).slug);
    for (const subject of meeting.subjects) entityTargets.add(target(subject.type,subject.name,subject.existing_slug).slug);
    meetings.push({...meeting,target_slug:mt.slug,entity_slugs:[...entityTargets]});
  }
  if (targets.length > 200) throw new Error("Page targets exceed the bounded complete source plan");
  const source = prepared.source;
  if ([source.identity,source.version].some(x => typeof x !== 'string' || x.length > 256)) throw new Error("Source provenance exceeds the Brain write contract");
  const quote = (x:any) => JSON.stringify(x);
  const markdown = '---\ntype: source\ntitle: "Imported meeting source"\nsource_identity: ' + quote(source.identity) + '\nsource_version: ' + quote(source.version) + '\nrecord_version_id: ' + quote(source.context.companyos_record_version) + '\nsource_kind: ' + quote(source.kind) + '\nmeeting_segments: ' + quote(meetings.map(m=>({slug:m.target_slug,start:m.start,end:m.end}))) + '\n---\n\n# Imported meeting source\n\nComplete transcript and participant context are retained in the authorized Company Record for this exact source identity and version.\n\n[Original source](' + source.original_url.replace(/[()<>\s]/g, (x:string) => encodeURIComponent(x)) + ')\n';
  return {status:'page-targets-planned', targets, meetings, evidence:{slug:evidenceSlug,markdown}};
} });
