import { defineCompanyTool } from "@companyos/tool-sdk";

type PageRead = { found: boolean; status: string; page?: { slug: string; type: string; markdown: string; content_hash: string }; indexed_revision: { git_commit: string } };
const slugPattern = /^[a-z][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,119}$/;
const hasLink = (markdown: string, slug: string) => markdown.includes("[[" + slug + "]]")
  || new RegExp("\\[\\[" + slug + "\\|[^\\]\\n]{1,160}\\]\\]").test(markdown);
const yamlField = (markdown: string, key: string) => new RegExp("^" + key + ":[ \\t]*(.+)$", "m").exec(markdown)?.[1]?.trim();
const sourceDay = (value: string) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw Error("An exact source event date is required");
  return value.slice(0, 10);
};
const processingDay = (value: string) => {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw Error("A trusted processing instant is required");
  return time.toISOString().slice(0, 10);
};
function stampMetadata(markdown: string, type: string, existing: PageRead | undefined, occurredAt: string, instant: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match || markdown.length > 100000) throw Error("A bounded complete Markdown page with frontmatter is required");
  const front = match[1];
  if (yamlField(front, "type") !== type || !yamlField(front, "title")) throw Error("Page type and title must match the target");
  if (["created", "updated", "date"].some(key => (front.match(new RegExp("^" + key + ":", "gm")) ?? []).length > 1)) throw Error("Duplicate date metadata is not allowed");
  const today = processingDay(instant), oldCreated = existing?.found ? yamlField(existing.page!.markdown, "created") : undefined;
  if (oldCreated && !/^\d{4}-\d{2}-\d{2}$/.test(oldCreated)) throw Error("Existing page creation date is invalid");
  let next = front.replace(/^created:.*(?:\r?\n|$)/gm, "").replace(/^updated:.*(?:\r?\n|$)/gm, "");
  if (oldCreated || !existing?.found) next += "\ncreated: " + (oldCreated ?? today);
  next += "\nupdated: " + today;
  if (type === "meeting") {
    const date = sourceDay(occurredAt), declared = yamlField(front, "date");
    if (declared && declared !== date) throw Error("Meeting date conflicts with the original source");
    if (!declared) next += "\ndate: " + date;
  }
  const rawTags = yamlField(front, "tags");
  if (rawTags && (!/^\[[a-z0-9_-]+(?:, ?[a-z0-9_-]+){0,7}\]$/.test(rawTags) || rawTags.length > 160)) throw Error("Tags must be a bounded list of plain labels");
  if (!rawTags) next += "\ntags: [" + type + "]";
  return "---\n" + next.trim() + "\n---\n" + markdown.slice(match[0].length);
}
function pruneNonVerbatimQuotes(markdown: string, original: string): { markdown: string; removed: number } {
  const section = /(^## Notable Quotes\s*\n)([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(markdown);
  if (!section) return { markdown, removed: 0 };
  let removed = 0, retained = 0;
  const body = section[2].split("\n").map(line => {
    const block = /^>\s*(.+)$/.exec(line);
    if (!block) return line;
    const quoted = /^["“]([^"”]+)["”](?:\s+.*)?$/.exec(block[1].trim());
    const text = quoted?.[1] ?? block[1].trim();
    if (!text || !original.includes(text)) { removed++; return ""; }
    retained++; return "> " + text;
  }).filter(Boolean).join("\n");
  const next = retained || !removed ? body : "No verbatim quote retained.\n" + body;
  return { markdown: markdown.slice(0, section.index) + section[1] + next.trimEnd() + "\n\n" + markdown.slice(section.index + section[0].length), removed };
}

export default defineCompanyTool({ async execute(input: any, context: any) {
  const { task, route, prompt_paths, processing_instant } = input;
  if (task?.triage?.coverage_complete !== true || !["reasoning", "deep"].includes(route)
    || !task?.source || !task?.evidence || typeof task.original_text !== "string") throw Error("Complete admitted source evidence is required");
  const source = task.source, evidence = task.evidence.slug;
  if (typeof source.identity !== "string" || typeof source.version !== "string" || !slugPattern.test(evidence)
    || !task.evidence.markdown.includes(source.identity) || !task.evidence.markdown.includes(source.version)) throw Error("Exact source provenance is required");
  const directories = task.directories;
  if (!directories || Object.keys(directories).sort().join(",") !== "company,concept,meeting,person,source"
    || Object.values(directories).some((value: any) => typeof value !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value))) throw Error("Reviewed directory mapping is required");
  if (!prompt_paths || Object.keys(prompt_paths).sort().join(",") !== "deep,reasoning"
    || Object.values(prompt_paths).some((value: any) => typeof value !== "string" || !value.startsWith("agents/"))) throw Error("Reviewed one-shot prompt bindings are required");
  sourceDay(source.occurred_at);
  processingDay(processing_instant);
  if (source.kind !== "meeting" || task.original_text.length > 130000 || task.prior.requests.length > 8) return { route: "agent", reason: "Source type or reconciliation context exceeds the bounded meeting synthesis", outcome: null };
  let effectStarted = false;
  try {
    const prefetch = new Map<string, PageRead>();
    const read = async (slug: string) => {
      if (!slugPattern.test(slug)) throw Error("Unsafe page identity");
      if (prefetch.has(slug)) return prefetch.get(slug)!;
      const page = await context.capabilities.call("brain.entity", { name: slug }) as PageRead;
      if (!page || !["found", "not_found"].includes(page.status) || (page.found && page.page?.slug !== slug)) throw Error("Page lookup is ambiguous or incomplete");
      prefetch.set(slug, page);
      return page;
    };
    await read(evidence);
    for (const prior of task.prior.requests) await read(prior.slug);
    const participants = source.context?.participants;
    if (participants !== undefined && (!Array.isArray(participants) || participants.length > 8)) throw Error("Participant resolution exceeds the bounded one-shot scope");
    const participantResolution: any[] = [];
    for (const participant of participants ?? []) {
      const rawName = typeof participant === "string" ? participant
        : participant?.name ?? participant?.display_name ?? participant?.displayName ?? participant?.person?.name;
      if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 160) {
        participantResolution.push({ name: null, status: "unresolved", slug: null });
        continue;
      }
      const name = rawName.trim();
      const result = await context.capabilities.call("brain.entity", { name }) as PageRead;
      if (!result || !["found", "not_found"].includes(result.status)) throw Error("Participant name resolution is ambiguous");
      if (result.found && (!result.page || result.page.type !== "person" || !slugPattern.test(result.page.slug))) throw Error("Resolved participant is not a canonical person page");
      if (result.found && result.page) prefetch.set(result.page.slug, result);
      participantResolution.push({ name, status: result.status, slug: result.page?.slug ?? null });
    }
    const queries = [...new Set((task.triage.items ?? []).map((item: any) => item.classification?.one_line_summary).filter((value: any) => typeof value === "string" && value.trim()).slice(0, 2))];
    const retrieval: any[] = [];
    for (const query of queries) {
      const result = await context.capabilities.call("brain.recall", { query: query.slice(0, 500), limit: 8 }) as any;
      if (!result?.indexed_revision || !Array.isArray(result.hits)) throw Error("Brain retrieval is incomplete");
      retrieval.push({ query, hits: result.hits.map((hit: any) => ({ slug: hit.slug, excerpt: hit.excerpt ?? hit.text ?? "" })) });
      for (const hit of result.hits) if (typeof hit.slug === "string" && prefetch.size < 9) await read(hit.slug);
    }
    const existing = [...prefetch.values()].filter(page => page.found && page.page).map(page => ({
      slug: page.page!.slug, markdown: page.page!.markdown, content_hash: page.page!.content_hash,
    }));
    if (JSON.stringify(existing).length > 30000) return { route: "agent", reason: "Relevant existing pages exceed the one-shot context budget", outcome: null };
    const prompt = route === "deep" ? prompt_paths.deep : prompt_paths.reasoning;
    const generated = await context.capabilities.call("language.generate", { prompt_path: prompt,
      data: { source_identity: source.identity, source_version: source.version, source_kind: source.kind,
        occurred_at: source.occurred_at, original_url: source.original_url, original_text: task.original_text,
        participants: participants ?? [], participant_resolution: participantResolution,
        triage: task.triage, prior: task.prior, directories, internal_evidence_page: evidence,
        existing_pages: existing, retrieval } }) as any;
    if (typeof generated?.text !== "string" || generated.text.length > 60000) throw Error("One-shot output is incomplete or unbounded");
    const draft = JSON.parse(generated.text);
    if (draft.source_identity !== source.identity || draft.source_version !== source.version
      || !Array.isArray(draft.pages) || draft.pages.length < 1 || draft.pages.length > 15
      || Object.keys(draft).sort().join(",") !== "gaps,meetings,pages,source_identity,source_version,verification"
      || !Array.isArray(draft.meetings) || !Array.isArray(draft.verification) || !Array.isArray(draft.gaps)
      || draft.gaps.length > 100 || draft.gaps.some((gap: any) => typeof gap !== "string" || gap.length > 2000)) throw Error("One-shot source identity or page coverage is invalid");
    const types = new Map([[directories.person, "person"], [directories.company, "company"], [directories.concept, "concept"], [directories.meeting, "meeting"]]);
    if (draft.verification.length !== 6 || new Set(draft.verification.map((item: any) => item?.check)).size !== 6
      || !["V1", "V2", "V3", "V4", "V5", "V6"].every(check => draft.verification.some((item: any) => item?.check === check))
      || draft.verification.some((item: any) => !["passed", "not-applicable", "flagged-uncertainty"].includes(item?.status)
        || typeof item?.detail !== "string" || !item.detail.trim() || item.detail.length > 2000)) throw Error("All six proposed verification observations are required");
    const slugs = new Set<string>([evidence]), pages: any[] = [];
    let removedQuotes = 0;
    const evidenceRead = prefetch.get(evidence)!;
    if (evidenceRead.found && evidenceRead.page?.markdown !== task.evidence.markdown) throw Error("Existing source evidence differs from the exact source version");
    if (!evidenceRead.found) pages.push({ path: "brain/" + evidence + ".md", expected_content_hash: null, markdown: task.evidence.markdown });
    for (const proposal of draft.pages) {
      if (!proposal || Object.keys(proposal).sort().join(",") !== "markdown,slug" || typeof proposal.slug !== "string"
        || !slugPattern.test(proposal.slug) || slugs.has(proposal.slug) || typeof proposal.markdown !== "string") throw Error("Unsafe or duplicate page proposal");
      slugs.add(proposal.slug);
      const type = types.get(proposal.slug.split("/")[0]);
      if (!type) throw Error("Proposal is outside the reviewed page directories");
      const current = await read(proposal.slug);
      let markdown = stampMetadata(proposal.markdown, type, current, source.occurred_at, processing_instant);
      if (type === "meeting") {
        const pruned = pruneNonVerbatimQuotes(markdown, task.original_text);
        markdown = pruned.markdown; removedQuotes += pruned.removed;
      }
      if (!hasLink(markdown, evidence)) throw Error("Page lacks exact internal original-source evidence");
      if (type === "meeting" && !["## Summary", "## Key Decisions", "## Action Items", "## Notable Quotes"].every(section => markdown.includes(section))) throw Error("Meeting page lacks required sections");
      if (type !== "meeting" && !markdown.includes("<!-- timeline -->")) throw Error("Entity page lacks a Timeline");
      if (current.found && current.page) {
        if (current.page.type !== type) throw Error("Existing page type conflicts with proposal");
        const before = current.page.markdown.split("<!-- timeline -->")[1]?.trim();
        if (before && !markdown.split("<!-- timeline -->")[1]?.includes(before)) throw Error("Proposal drops existing Timeline history");
      }
      pages.push({ path: "brain/" + proposal.slug + ".md", expected_content_hash: current.found ? current.page!.content_hash : null, markdown });
    }
    if (pages.length > 16 || pages.reduce((size, page) => size + page.markdown.length, 0) > 400000) throw Error("One-shot write exceeds the standard Brain batch");
    const meetingPages = pages.filter(page => page.path.startsWith("brain/" + directories.meeting + "/"));
    if (meetingPages.length !== 1 || draft.meetings.length !== 1) throw Error("One-shot synthesis requires one source meeting; split meetings use the Agent fallback");
    const meetingSlug = meetingPages[0].path.slice(6, -3), meeting = draft.meetings[0];
    if (meeting?.slug !== meetingSlug || !Array.isArray(meeting.attendees) || !Array.isArray(meeting.entities)
      || meeting.attendees.length > 100 || meeting.entities.length > 100
      || new Set(meeting.attendees).size !== meeting.attendees.length) throw Error("Meeting and attendee coverage is incomplete");
    for (const attendee of meeting.attendees) {
      if (typeof attendee !== "string" || !attendee.startsWith(directories.person + "/") || !slugPattern.test(attendee)) throw Error("Attendee identity is invalid");
      const person = pages.find(page => page.path === "brain/" + attendee + ".md");
      const retained = prefetch.get(attendee);
      if (!person && !hasLink(retained?.page?.markdown.split("<!-- timeline -->")[1] ?? "", meetingSlug)) throw Error("A confirmed attendee lacks a meeting Timeline backlink");
      if (!hasLink(meetingPages[0].markdown, attendee)
        || person && !hasLink(person.markdown.split("<!-- timeline -->")[1] ?? "", meetingSlug)) throw Error("Meeting/person links or Timeline backlink are missing");
    }
    for (const entity of meeting.entities) {
      if (typeof entity !== "string" || !slugPattern.test(entity)
        || !hasLink(meetingPages[0].markdown, entity)
        || !pages.some(page => page.path === "brain/" + entity + ".md") && !prefetch.get(entity)?.found) throw Error("Meeting entity reference is unresolved");
    }
    const quoteSection = meetingPages[0].markdown.split("## Notable Quotes")[1]?.split(/^## /m)[0] ?? "";
    for (const line of quoteSection.split("\n")) {
      const quote = /^>\s*(.+)$/.exec(line)?.[1]?.trim();
      if (quote && !task.original_text.includes(quote)) throw Error("A notable quote is not verbatim in the retained source");
    }
    const revision = [...prefetch.values()][0]?.indexed_revision?.git_commit;
    if (!/^[a-f0-9]{40}$/.test(revision) || [...prefetch.values()].some(page => page.indexed_revision?.git_commit !== revision)) throw Error("Page reads do not share one indexed revision");
    const changes = { expected_revision: revision, pages };
    const provenance = { source_id: source.identity, source_version: source.version, action: "one-shot-import", evidence: [evidence] };
    const operation_key = context.runId + ":one-shot-import";
    effectStarted = true;
    const receipt = await context.capabilities.call("brain.remember", { changes, provenance, operation_key }) as any;
    if (!receipt || !["saved", "unchanged"].includes(receipt.status) || !["indexed", "current_head_indexed"].includes(receipt.sync_status)) throw Error("Brain write or indexing has no settled receipt");
    const verified: any[] = [];
    for (const page of pages) {
      const slug = page.path.slice(6, -3);
      const actual = await context.capabilities.call("brain.entity", { name: slug }) as PageRead;
      if (!actual?.found || actual.page?.slug !== slug || actual.page.markdown !== page.markdown) throw Error("Saved page read-back does not match the planned Markdown");
      verified.push({ slug, content_hash: actual.page.content_hash });
    }
    const verification = draft.verification.map((item: any) => ({
      check: item.check,
      status: ["V1", "V2", "V4"].includes(item.check) ? "passed" : item.status === "not-applicable" ? "not-applicable" : "flagged-uncertainty",
      detail: ["V1", "V2", "V4"].includes(item.check)
        ? "Saved Markdown passed the deterministic sections, backlinks or verbatim blockquote check."
        : "Model observation after structural read-back: " + item.detail,
    }));
    return { route: "one-shot", reason: null, outcome: { status: task.prior.requests.length ? "reconciled" : "ingested",
      source_identity: source.identity, source_version: source.version, pages: verified, receipts: [receipt],
      indexed_revision: receipt.indexed_revision, verification,
      gaps: removedQuotes ? [...draft.gaps, "Removed " + removedQuotes + " proposed non-verbatim blockquote(s) before saving."] : draft.gaps } };
  } catch (error) {
    if (effectStarted) throw error;
    return { route: "agent", reason: String(error instanceof Error ? error.message : error).slice(0, 500), outcome: null };
  }
} });
