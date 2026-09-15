import type { LanguageGenerator, LanguageGenerationResult } from "../language/contracts.ts";
import { BrainError, type BrainPage } from "./contracts.ts";
import { BrainReads, requireText } from "./reads.ts";
import { SYNTHESIS_INSTRUCTIONS } from "./upstream/synthesis.ts";

type EvidencePage = Pick<BrainPage, "slug" | "title" | "search_text" | "timeline" | "takes" | "original_links" | "links">;
type Citation = { page_slug: string; row_num: number | null; citation_index: number };
export interface BrainSynthesisModel {
  /** Resolve configured model capability before composition. Unavailable remains an explicit error. */
  prepare(): LanguageGenerator;
}

export async function synthesizeBrain(reads: BrainReads, question: string, agentId: string, model?: BrainSynthesisModel) {
  question = requireText(question, "question", 2000);
  if (!model) throw new BrainError("model_unavailable", "Brain synthesis needs a configured language model; recall and entity remain available.");
  const gathered = await reads.snapshot(async revision => {
    const found = await reads.recallAt(revision, { query: question, limit: 12 });
    const primary = await reads.store.pages(reads.scope, revision, [...new Set(found.hits.map(hit => hit.slug))].slice(0, 8));
    const references = [...new Set(primary.flatMap(page => page.links.filter(link => link.resolved).map(link => link.resolved!)))];
    const linked = await reads.store.pages(reads.scope, revision, references.filter(slug => !primary.some(page => page.slug === slug)).slice(0, 8));
    const pages: EvidencePage[] = [], omitted: string[] = [];
    let units = 0;
    for (const page of [...primary, ...linked]) {
      const item = { slug: page.slug, title: page.title, search_text: page.search_text, timeline: page.timeline,
        takes: page.takes.filter(take => take.active), original_links: page.original_links, links: page.links };
      const size = JSON.stringify(item).length;
      if (units + size > 120_000) { omitted.push(page.slug); continue; }
      pages.push(item); units += size;
    }
    return { pages, omitted, retrieval_limited: found.has_more || references.length > 8, indexed_revision: revision };
  });
  const generate = model.prepare();
  if (!gathered.pages.length) return { answer: "", sources: [], gaps: [gathered.omitted.length ? "Available pages exceeded the bounded evidence budget." : "No usable evidence was found for this question."],
    synthesis_status: "insufficient_evidence", cost: null, indexed_revision: gathered.indexed_revision };
  let generated: LanguageGenerationResult | undefined;
  try {
    generated = await generate({ instructions: SYNTHESIS_INSTRUCTIONS, data: JSON.stringify({ question, ...gathered }), agentId, modelTask: "brain.synthesize", modelProfile: "reasoning" });
    if (generated.text.length > 20_000 || generated.evidence.finish_reason !== "stop") throw new Error("Incomplete synthesis");
    const output = JSON.parse(generated.text);
    if (!output || typeof output.answer !== "string" || !output.answer.trim() || output.answer.length > 16_000
      || !Array.isArray(output.gaps) || output.gaps.length > 32 || output.gaps.some((gap: unknown) => typeof gap !== "string" || gap.length > 1000)
      || !Array.isArray(output.citations) || !output.citations.length || output.citations.length > 64
      || Object.keys(output).some(key => !["answer", "gaps", "citations"].includes(key))) throw new Error("Invalid synthesis response");
    const permitted = new Set(gathered.pages.flatMap(page => [page.slug, ...page.takes.map(take => `${page.slug}#${take.row_num}`)]));
    const cited = new Set<string>();
    const sources = (output.citations as Citation[]).map(citation => {
      if (!citation || typeof citation.page_slug !== "string" || !(citation.row_num === null || Number.isSafeInteger(citation.row_num))
        || !Number.isSafeInteger(citation.citation_index) || citation.citation_index < 1) throw new Error("Invalid citation shape");
      const key = `${citation.page_slug}${citation.row_num === null ? "" : `#${citation.row_num}`}`;
      if (!permitted.has(key) || !output.answer.includes(`[${key}]`)) throw new Error("Citation was not gathered or used inline");
      cited.add(key);
      const page = gathered.pages.find(page => page.slug === citation.page_slug)!;
      return { page_slug: page.slug, row_num: citation.row_num, original_links: page.original_links, evidence_links: page.links.filter(link => link.resolved).map(link => link.resolved),
        ...(citation.row_num === null ? {} : { take: page.takes.find(take => take.row_num === citation.row_num) }) };
    });
    for (const match of output.answer.matchAll(/\[([a-z0-9][a-z0-9._/-]*(?:#\d+)?)\](?!\()/g)) if (!cited.has(match[1])) throw new Error("Undeclared inline citation");
    return { answer: output.answer, sources, gaps: [...output.gaps, ...(gathered.retrieval_limited || gathered.omitted.length ? ["Retrieval was bounded; additional material may have been omitted."] : [])],
      synthesis_status: "ok", cost: generated.evidence.model_execution ?? null, indexed_revision: gathered.indexed_revision };
  } catch {
    let answer = "";
    const sources: Array<{ page_slug: string; row_num: null; original_links: string[]; evidence_links: string[] }> = [];
    for (const page of gathered.pages) {
      const excerpt = `[${page.slug}] ${page.title}\n${page.search_text.slice(0, 1400)}\n`;
      if (answer.length + excerpt.length > 8000) break;
      answer += excerpt; sources.push({ page_slug: page.slug, row_num: null, original_links: page.original_links, evidence_links: page.links.flatMap(link => link.resolved ? [link.resolved] : []) });
    }
    return { answer, sources, gaps: ["Composition or citation validation failed. These are bounded source excerpts, not a synthesized answer."],
      synthesis_status: "extractive_fallback", cost: generated?.evidence.model_execution ?? null, indexed_revision: gathered.indexed_revision };
  }
}
