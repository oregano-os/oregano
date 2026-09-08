import type { JsonSchema, JsonValue } from "../capabilities/contracts.ts";
import type { RecordTextParserDeclaration } from "./contracts.ts";

export const MAX_RECORD_TEXT_LENGTH = 65_536;
export const MAX_RECORD_TEXT_LINKS = 1_000;
const fieldId = /^[a-z][a-z0-9_]{0,62}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const label = (value: string) => value.trim().replace(/^[#*_]+\s*|\s*[*_]+$/g, "").trim().toLowerCase();
const safeId = (value: string) => fieldId.test(value) && !forbidden.has(value);
const literal = (value: unknown): value is string => typeof value === "string" && label(value).length > 0 && value === value.trim() && value.length <= 255 && !/[\r\n]/.test(value);

export function validateRecordTextParser(parser: RecordTextParserDeclaration): void {
  if (parser.kind !== "sectioned-text" || parser.version !== 1 || !literal(parser.starts_with) || !literal(parser.source)) {
    throw new Error("Record text parser requires version 1, a source path and a literal prefix");
  }
  if (!Array.isArray(parser.sections) || parser.sections.length < 1 || parser.sections.length > 32) throw new Error("Record text parser requires 1 to 32 sections");
  const ids = new Set<string>();
  const headings = new Set<string>();
  for (const section of parser.sections) {
    if (!safeId(section.id) || ids.has(section.id) || !literal(section.heading) || headings.has(label(section.heading))) throw new Error("Record text parser section identities and headings must be distinct literals");
    ids.add(section.id);
    headings.add(label(section.heading));
    if (typeof section.required !== "boolean" || (section.fields?.length ?? 0) > 32) throw new Error("Record text parser section requirements or field bounds are invalid");
    const fields = new Set<string>();
    const prefixes: string[] = [];
    for (const field of section.fields ?? []) {
      if (!safeId(field.id) || fields.has(field.id) || typeof field.required !== "boolean" || !Array.isArray(field.prefixes) || field.prefixes.length < 1 || field.prefixes.length > 8) throw new Error("Record text parser field declaration is invalid");
      fields.add(field.id);
      for (const prefix of field.prefixes) {
        if (!literal(prefix)) throw new Error("Record text parser field prefixes must be literals");
        const normalized = label(prefix);
        if (prefixes.some((candidate) => candidate.startsWith(normalized) || normalized.startsWith(candidate))) throw new Error("Record text parser field prefixes must not overlap");
        prefixes.push(normalized);
      }
    }
    if (section.links) {
      const links = section.links;
      if (!safeId(links.id_field) || ["url", "text"].includes(links.id_field) || typeof links.required !== "boolean") throw new Error("Record text parser link field is invalid");
      if (!Array.isArray(links.hosts) || !links.hosts.length || links.hosts.length > 16 || links.hosts.some((host) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) || new Set(links.hosts).size !== links.hosts.length) throw new Error("Record text parser link hosts must be distinct exact lowercase hostnames");
      if (!literal(links.path) || !links.path.startsWith("/") || links.path.split("/").filter((part) => part === "{id}").length !== 1 || links.path.split("/").slice(1).some((part) => !part || (part !== "*" && part !== "{id}" && !/^[a-zA-Z0-9_-]+$/.test(part)))) throw new Error("Record text parser link path requires one {id} and literal or wildcard segments");
    }
  }
}

/** Exact output schema used by source validation and the workflow compiler. */
export function recordTextParserOutputSchema(parser: RecordTextParserDeclaration): JsonSchema {
  validateRecordTextParser(parser);
  const sections = Object.fromEntries(parser.sections.map((section): [string, JsonSchema] => {
    const fieldNames = (section.fields ?? []).map((field) => field.id);
    const itemProperties: Record<string, JsonSchema> = { url: { type: "string" }, text: { type: "string" } };
    if (section.links) itemProperties[section.links.id_field] = { type: "string" };
    return [section.id, {
      type: "object", additionalProperties: false, required: ["text", "fields", "ids", "items", "links"],
      properties: {
        text: { type: "string" },
        fields: { type: "object", additionalProperties: false, required: fieldNames, properties: Object.fromEntries(fieldNames.map((id) => [id, { type: "string" }])) },
        ids: { type: "array", items: { type: "string" }, maxItems: MAX_RECORD_TEXT_LINKS },
        links: { type: "array", items: { type: "string" }, maxItems: MAX_RECORD_TEXT_LINKS },
        items: { type: "array", maxItems: MAX_RECORD_TEXT_LINKS, items: { type: "object", additionalProperties: false, required: Object.keys(itemProperties), properties: itemProperties } },
      },
    }];
  }));
  return {
    type: "object", additionalProperties: false, required: ["matched", "well_formed", "sections", "issues"],
    properties: {
      matched: { type: "boolean" }, well_formed: { type: "boolean" },
      sections: { type: "object", additionalProperties: false, required: Object.keys(sections), properties: sections },
      issues: { type: "array", items: { type: "string" } },
    },
  };
}

interface ParsedSection {
  text: string;
  fields: Record<string, string>;
  ids: string[];
  items: Array<Record<string, string>>;
  links: string[];
}

const linkIdentity = (urlText: string, links: NonNullable<RecordTextParserDeclaration["sections"][number]["links"]>): string | undefined => {
  try {
    const url = new URL(urlText);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !links.hosts.includes(url.hostname)) return undefined;
    const path = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const pattern = links.path.split("/").slice(1);
    if (path.length !== pattern.length || path.some((part) => !part || /[\s/\\\u0000-\u001f]/.test(part))) return undefined;
    if (pattern.some((part, index) => part !== "*" && part !== "{id}" && part !== path[index])) return undefined;
    return path[pattern.indexOf("{id}")];
  } catch { return undefined; }
};

/** Bounded data transformation. No evaluation, network, clocks or roster access. */
export function parseRecordText(parser: RecordTextParserDeclaration, input: JsonValue | undefined): Record<string, JsonValue> {
  validateRecordTextParser(parser);
  if (typeof input === "string" && input.length > MAX_RECORD_TEXT_LENGTH) throw new Error("Record text exceeds the parser input bound");
  const text = typeof input === "string" ? input : "";
  const lines = text.split(/\r?\n/);
  const first = lines.find((line) => line.trim()) ?? "";
  const prefix = label(parser.starts_with);
  const firstLabel = label(first);
  const matched = firstLabel.startsWith(prefix) && (!/[a-z0-9]$/i.test(prefix) || !/[a-z0-9]/i.test(firstLabel.charAt(prefix.length)));
  const sections: Record<string, ParsedSection> = Object.fromEntries(parser.sections.map((section) => [section.id, {
    text: "", fields: Object.fromEntries((section.fields ?? []).map((field) => [field.id, ""])), ids: [], items: [], links: [],
  }]));
  const issues: string[] = [];
  if (!matched) return { matched, well_formed: false, sections: sections as unknown as JsonValue, issues };
  const seen = new Set<string>();
  let active: string | undefined;
  let previousIndex = -1;
  for (const line of lines.slice(lines.indexOf(first) + 1)) {
    const index = parser.sections.findIndex((section) => label(section.heading) === label(line));
    if (index >= 0) {
      const section = parser.sections[index]!;
      if (seen.has(section.id)) issues.push(`duplicate-section:${section.id}`);
      if (index <= previousIndex) issues.push(`section-order:${section.id}`);
      seen.add(section.id);
      previousIndex = index;
      active = section.id;
    } else if (active) sections[active]!.text += `${line}\n`;
  }
  let linkCount = 0;
  for (const definition of parser.sections) {
    const section = sections[definition.id]!;
    section.text = section.text.trim();
    if (definition.required && !seen.has(definition.id)) issues.push(`missing-section:${definition.id}`);
    for (const field of definition.fields ?? []) {
      const matches = section.text.split("\n").flatMap((line) => {
        // Keep value case and punctuation; only label matching is case-insensitive.
        const trimmed = line.trim().replace(/^([*_]{1,2})(.+?)\1/, "$2");
        const prefix = field.prefixes.find((candidate) => trimmed.toLowerCase().startsWith(candidate.toLowerCase()));
        return prefix ? [trimmed.slice(prefix.length).trim()] : [];
      });
      if (matches.length > 1) issues.push(`duplicate-field:${definition.id}.${field.id}`);
      section.fields[field.id] = matches[0] ?? "";
      if (field.required && !section.fields[field.id]) issues.push(`missing-field:${definition.id}.${field.id}`);
    }
    if (!definition.links) continue;
    for (const line of section.text.split("\n")) {
      // One occurrence per visible URL, including Slack <url|label> and Markdown.
      for (const match of line.matchAll(/https?:\/\/[^\s<>|]+/g)) {
        const url = match[0].replace(/[\]).,;]+$/, "");
        if (++linkCount > MAX_RECORD_TEXT_LINKS) throw new Error("Record text exceeds the parser link bound");
        section.links.push(url);
        const id = linkIdentity(url, definition.links);
        if (!id) { issues.push(`unrecognized-link:${definition.id}`); continue; }
        // Preserve extra and duplicate identities so consumers cannot miss them.
        section.ids.push(id);
        section.items.push({ [definition.links.id_field]: id, url, text: line.trim() });
      }
    }
    if (new Set(section.ids).size !== section.ids.length) issues.push(`duplicate-link:${definition.id}`);
    if (definition.links.required && !section.ids.length) issues.push(`missing-link:${definition.id}`);
  }
  return { matched, well_formed: issues.length === 0, sections: sections as unknown as JsonValue, issues };
}
