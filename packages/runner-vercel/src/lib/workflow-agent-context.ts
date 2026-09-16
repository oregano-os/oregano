import type { JsonValue } from "../../../capabilities/contracts.ts";

/** Present canonical Markdown once; retain the complete Tool receipt in Core. */
export function modelToolResult(name: string, value: JsonValue): JsonValue {
  if (name !== "oregano_brain_entity" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const page = value.page;
  if (value.found !== true || !page || typeof page !== "object" || Array.isArray(page) || typeof page.markdown !== "string") return value;
  const compact = structuredClone(value), saved = compact.page as Record<string, JsonValue>;
  // These are index projections of the retained complete Markdown, not extra evidence.
  for (const key of ["search_text", "compiled_truth", "timeline", "takes"]) delete saved[key];
  // Outgoing excerpts repeat the same complete Markdown. Preserve resolution
  // identities; incoming backlink excerpts are independent evidence and stay.
  const withoutExcerpt = (link: JsonValue): JsonValue => {
    if (!link || typeof link !== "object" || Array.isArray(link)) return link;
    const { context: _context, ...identity } = link;
    return identity;
  };
  if (Array.isArray(saved.links)) saved.links = saved.links.map(withoutExcerpt);
  if (Array.isArray(compact.outgoing)) compact.outgoing = compact.outgoing.map(withoutExcerpt);
  return compact;
}
