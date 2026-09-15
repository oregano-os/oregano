import YAML from "yaml";
import { BrainError, type BrainConfiguration, type BrainPageType } from "./contracts.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function parseBrainConfiguration(text: string): BrainConfiguration {
  if (text.length > 32_000) throw new BrainError("invalid_configuration", "Brain declaration exceeds its bound.");
  const document = YAML.parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw new BrainError("invalid_configuration", "Brain declaration must be valid YAML.");
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { throw new BrainError("invalid_configuration", "Brain declaration cannot use YAML aliases."); }
  const fail = (): never => { throw new BrainError("invalid_configuration", "Invalid Brain type, relationship or filing declaration."); };
  if (!object(value) || value.version !== 1 || !exact(value, ["version", "types", "relationships", "filing_guidance"])
    || !object(value.types) || Object.keys(value.types).length < 1 || Object.keys(value.types).length > 64) return fail();
  const types: Record<string, BrainPageType> = {};
  for (const [name, raw] of Object.entries(value.types)) {
    if (!id(name) || !object(raw) || !exact(raw, ["directory", "role", "search_weight"])
      || typeof raw.directory !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(raw.directory)
      || !["content", "person", "company", "evidence"].includes(String(raw.role ?? "content"))
      || (raw.search_weight !== undefined && (typeof raw.search_weight !== "number" || !Number.isFinite(raw.search_weight) || raw.search_weight <= 0 || raw.search_weight > 1))) return fail();
    types[name] = { directory: raw.directory, role: (raw.role ?? "content") as BrainPageType["role"], search_weight: Number(raw.search_weight ?? 1) };
  }
  const relationships: BrainConfiguration["relationships"] = {};
  if (value.relationships !== undefined) {
    if (!object(value.relationships) || Object.keys(value.relationships).length > 32) return fail();
    for (const [field, raw] of Object.entries(value.relationships)) {
      if (!id(field) || !object(raw) || !exact(raw, ["relation", "target_type"]) || !id(raw.relation)
        || typeof raw.target_type !== "string" || !Object.hasOwn(types, raw.target_type)) return fail();
      relationships[field] = { relation: raw.relation, target_type: raw.target_type };
    }
  }
  if (value.filing_guidance !== undefined && (typeof value.filing_guidance !== "string" || value.filing_guidance.length > 4000)) return fail();
  return { version: 1, types, relationships, filing_guidance: String(value.filing_guidance ?? "") };
}
