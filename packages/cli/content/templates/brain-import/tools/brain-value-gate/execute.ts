import { defineCompanyTool } from "@companyos/tool-sdk";

export default defineCompanyTool({ async execute(input: any) {
  const { expected_segments: expected, results, settings } = input;
  if (input.source_complete !== true || !Array.isArray(expected) || expected.length === 0 || expected.length > 1000 || new Set(expected).size !== expected.length || !Array.isArray(results) || results.length !== expected.length) throw new Error("Incomplete source triage coverage");
  const categories = settings.filing_categories;
  if (![settings.deep_filing, settings.skip_filing].every(list => list.every(value => categories.includes(value)))) throw new Error("Unknown configured filing category");
  const names = ["filing", "user_writing_present", "user_writing_quality", "emotional_significance", "business_significance", "era", "one_line_summary"];
  const seen = new Set();
  const items = results.map(result => {
    if (!expected.includes(result.key) || seen.has(result.key)) throw new Error("Unexpected or duplicate triage segment");
    seen.add(result.key);
    const classification = JSON.parse(result.output.text);
    if (!classification || typeof classification !== "object" || Array.isArray(classification) || Object.keys(classification).length !== names.length || names.some(key => !Object.hasOwn(classification, key))
      || !categories.includes(classification.filing) || typeof classification.user_writing_present !== "boolean" || typeof classification.era !== "string" || classification.era.length > 500
      || typeof classification.one_line_summary !== "string" || !classification.one_line_summary.trim() || classification.one_line_summary.length > 2000) throw new Error("Invalid original triage fields");
    const quality = classification.user_writing_quality, emotional = classification.emotional_significance, business = classification.business_significance;
    if (![quality, emotional, business].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10)) throw new Error("Invalid triage score");
    const route = settings.deep_filing.includes(classification.filing) || quality >= settings.deep_quality_at_least || emotional >= settings.deep_emotional_at_least || business >= settings.deep_business_at_least ? "deep"
      : settings.skip_filing.includes(classification.filing) && [quality, emotional, business].every(value => value < settings.skip_scores_below) ? "skip" : "reasoning";
    return { key: result.key, classification, route };
  });
  return { route: items.some(item => item.route === "deep") ? "deep" : items.some(item => item.route === "reasoning") ? "reasoning" : "skip", items, coverage_complete: true };
} });
