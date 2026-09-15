import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {prepared, gate, results} = input;
  if (prepared.source_complete !== true || gate.coverage_complete !== true) throw new Error("Complete source triage is required");
  if (gate.route === 'skip') {
    if (results.length) throw new Error("A skipped source cannot have an interpretation call");
    return {status: 'triage-skipped', meetings: [], lookups: [], meeting_searches: [], gaps: []};
  }
  if (results.length !== 1 || results[0].key !== 'source') throw new Error("Exactly one complete normalization result is required");
  const value = JSON.parse(results[0].output.text);
  const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
  const text = (x: any, max: number) => typeof x === 'string' && !!x.trim() && x.length <= max;
  const nullable = (x: any, max: number) => x === null || text(x, max);
  const types = ['person', 'company', 'concept'];
  if (!exact(value, ['meetings', 'lookup_requests', 'gaps']) || !Array.isArray(value.meetings) || !value.meetings.length || value.meetings.length > 40
    || !Array.isArray(value.lookup_requests) || value.lookup_requests.length > 200 || !Array.isArray(value.gaps) || value.gaps.length > 200 || value.gaps.some((x: any) => !text(x, 2000))) throw new Error("Invalid normalization JSON contract");
  const original = prepared.segments.map((s: any) => s.data.segment.text).join(''), starts: number[] = [];
  const gaps: string[] = [...value.gaps], lookups: any[] = [], meetings: any[] = [], searches: any[] = [];
  function lookup(type: string, name: string) {
    if (!lookups.some(x => x.type === type && x.name === name)) lookups.push({key: 'lookup-' + (lookups.length + 1), type, name});
  }
  for (const [i, m] of value.meetings.entries()) {
    if (!exact(m, ['start_marker', 'title', 'date', 'time', 'duration', 'attendees', 'subjects']) || !text(m.title, 160)
      || typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date) || !Number.isFinite(Date.parse(m.date)) || new Date(m.date).toISOString().slice(0, 10) !== m.date
      || !nullable(m.time, 80) || !nullable(m.duration, 80) || !Array.isArray(m.attendees) || m.attendees.length > 100 || !Array.isArray(m.subjects) || m.subjects.length > 100) throw new Error("Invalid provisional meeting fields");
    if (i === 0 ? m.start_marker !== null : !text(m.start_marker, 500)) throw new Error("Meeting boundaries must begin at the start of the retained source");
    const start = i === 0 ? 0 : original.indexOf(m.start_marker);
    if (i && (start <= starts[i - 1] || original[start - 1] !== '\n' || original.indexOf(m.start_marker, start + 1) !== -1)) throw new Error("Meeting split marker is missing, duplicated or out of source order");
    starts.push(start);
    for (const a of m.attendees) {
      if (!exact(a, ['source_label', 'name', 'confidence', 'evidence']) || !text(a.source_label, 200) || !nullable(a.name, 160)
        || !['high', 'medium', 'low'].includes(a.confidence) || !text(a.evidence, 2000) || (a.name === null && a.confidence !== 'low')) throw new Error("Invalid provisional attendee evidence");
      if (a.name !== null) lookup('person', a.name);
      if (a.name === null || a.confidence === 'low') gaps.push('Unresolved attendee attribution: ' + a.source_label);
    }
    for (const s of m.subjects) {
      if (!exact(s, ['type', 'name', 'evidence']) || !types.includes(s.type) || !text(s.name, 160) || !text(s.evidence, 2000)) throw new Error("Invalid provisional subject evidence");
      lookup(s.type, s.name);
    }
    const key = 'meeting-' + (i + 1);
    for (const offset of [-1, 0, 1]) searches.push({key: key + '-date-' + (offset + 1), query: new Date(Date.parse(m.date) + offset * 86400000).toISOString().slice(0, 10)});
    searches.push({key: key + '-title', query: m.title});
    for (const [n, name] of [...new Set(m.attendees.filter((a: any) => a.name).map((a: any) => a.name))].entries()) searches.push({key: key + '-attendee-' + n, query: name});
    lookup('meeting', m.title);
    meetings.push({key, start, end: 0, title: m.title, date: m.date, time: m.time, duration: m.duration, attendees: m.attendees, subjects: m.subjects});
  }
  for (const request of value.lookup_requests) {
    if (!exact(request, ['type', 'name']) || ![...types, 'meeting'].includes(request.type) || !text(request.name, 160)) throw new Error("Invalid requested Brain lookup");
    lookup(request.type, request.name);
  }
  for (let i = 0; i < meetings.length; i++) meetings[i].end = starts[i + 1] ?? original.length;
  if (meetings.some(m => m.end <= m.start) || lookups.length > 200 || searches.length > 200 || gaps.length > 200) throw new Error("Normalization exceeds bounded complete coverage");
  return {status: 'normalization-proposed', meetings, lookups, meeting_searches: searches, gaps};
} });
