import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  const {requests, results} = input;
  if (requests.length !== results.length || new Set(results.map((x: any) => x.key)).size !== results.length) throw new Error("Resolution result coverage is incomplete or duplicated");
  const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
  const text = (x: any, max: number) => typeof x === 'string' && !!x.trim() && x.length <= max;
  const meetings = requests.map((request: any) => {
    const result = results.find((x: any) => x.key === request.key);
    if (!result) throw new Error("Missing meeting resolution");
    const value = JSON.parse(result.output.text), data = request.data, host = data.host_context, provisional = data.provisional_meeting;
    if (!exact(value, ['attendees', 'subjects', 'dedup', 'unresolved', 'gap_reviews']) || !Array.isArray(value.attendees) || value.attendees.length > 100 || !Array.isArray(value.subjects) || value.subjects.length > 100
      || !Array.isArray(value.unresolved) || value.unresolved.length > 200 || value.unresolved.some((x: any) => !text(x, 2000))) throw new Error("Invalid meeting resolution contract");
    const prior = [...new Set(host.prior_gaps)];
    if (!Array.isArray(value.gap_reviews) || value.gap_reviews.length !== prior.length || new Set(value.gap_reviews.map((x: any) => x.gap)).size !== prior.length
      || value.gap_reviews.some((x: any) => !exact(x, ['gap', 'outcome', 'evidence']) || !prior.includes(x.gap) || !['resolved', 'unresolved'].includes(x.outcome) || !text(x.evidence, 2000))) throw new Error("Every prior uncertainty requires an evidenced resolution or retained gap");
    for (const review of value.gap_reviews) if (review.outcome === 'unresolved' && !value.unresolved.includes(review.gap)) value.unresolved.push(review.gap);
    const resolveTarget = (item: any, type: string) => {
      const lookup = host.entity_lookups.find((x: any) => x.key === item.lookup_key && x.type === type);
      if (!lookup) throw new Error("Resolved target lacks an authorized name lookup");
      if (item.existing_slug === null) {
        if (lookup.status !== 'not_found' || lookup.name !== item.name) throw new Error("A new target requires its own complete not_found lookup");
      } else {
        const page = host.pages.find((p: any) => p.slug === item.existing_slug && p.type === type);
        if (!page || !lookup.slugs.includes(page.slug) || ![page.title, ...page.aliases, page.slug].includes(item.name)) throw new Error("Resolved identity is outside the read candidate set or declared aliases");
      }
    };
    const labels = new Set<string>();
    for (const item of value.attendees) {
      if (!exact(item, ['source_label', 'name', 'confidence', 'evidence', 'lookup_key', 'existing_slug']) || !text(item.source_label, 200) || labels.has(item.source_label)
        || !text(item.evidence, 2000) || !['high', 'medium', 'low'].includes(item.confidence)) throw new Error("Invalid resolved attendee evidence");
      labels.add(item.source_label);
      if (item.name === null) {
        if (item.confidence !== 'low' || item.lookup_key !== null || item.existing_slug !== null) throw new Error("Unknown attendees cannot acquire an entity target");
      } else {
        if (!text(item.name, 160) || item.confidence === 'low') throw new Error("Inferred attendee identities must remain explicitly unknown");
        resolveTarget(item, 'person');
      }
    }
    if (provisional.attendees.some((a: any) => !labels.has(a.source_label))) throw new Error("Resolution silently dropped a source attendee label");
    for (const item of value.subjects) {
      if (!exact(item, ['type', 'name', 'evidence', 'lookup_key', 'existing_slug']) || !['person', 'company', 'concept'].includes(item.type) || !text(item.name, 160) || !text(item.evidence, 2000)) throw new Error("Invalid resolved subject evidence");
      resolveTarget(item, item.type);
    }
    // Every proposed subject must remain represented or explicitly unresolved.
    for (const item of provisional.subjects) if (!value.subjects.some((s: any) => s.type === item.type && host.entity_lookups.find((l: any) => l.key === s.lookup_key)?.name === item.name)
      && !value.unresolved.some((gap: string) => gap.includes(item.name))) throw new Error("Resolution silently dropped a proposed subject");
    if (!exact(value.dedup, ['existing_slug', 'evidence']) || !text(value.dedup.evidence, 2000)) throw new Error("Invalid meeting deduplication evidence");
    if (value.dedup.existing_slug !== null) {
      const allowed = new Set([...host.meeting_searches.flatMap((x: any) => x.slugs), ...host.entity_lookups.filter((x: any) => x.type === 'meeting').flatMap((x: any) => x.slugs)]);
      if (!allowed.has(value.dedup.existing_slug) || !host.pages.some((p: any) => p.slug === value.dedup.existing_slug && p.type === 'meeting')) throw new Error("Meeting match lacks a complete authorized candidate page");
    }
    return {key: request.key, ...provisional, attendees: value.attendees, subjects: value.subjects, dedup: value.dedup,
      unresolved: value.unresolved, gap_reviews: value.gap_reviews, source_comparison: value.dedup.existing_slug === null ? 'not-applicable' : 'required', indexed_revision: host.indexed_revision};
  });
  return {status: meetings.length ? 'resolution-reviewed' : 'triage-skipped', meetings};
} });
