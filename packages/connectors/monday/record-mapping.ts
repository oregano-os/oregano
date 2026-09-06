import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";

export type MondayRecordMapping = {
  columns: Record<string, { id: string; type: string }>;
  groups: Record<string, string>;
};
type BoardSchema = {
  columns: Array<{ id: string; type: string; archived?: boolean }>;
  groups: Array<{ id: string; archived?: boolean; deleted?: boolean }>;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Monday mapping must contain objects");
  return value as Record<string, unknown>;
};
const literal = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Monday mapping contains an unsupported option");
};
const entries = (value: unknown) => {
  const result = Object.entries(value === undefined ? {} : object(value));
  if (result.length > 100 || result.some(([key]) => !literal(key))) throw new Error("Monday mapping requires at most one hundred safe literal keys");
  return result;
};

/** Optional logical names are Instance bindings, never provider-label inference. */
export function parseMondayRecordMapping(source: CompanyRecordSourceDeclaration, value: unknown): MondayRecordMapping | undefined {
  let mapping: MondayRecordMapping | undefined;
  if (value !== undefined) {
    const input = object(value); keys(input, ["columns", "groups"]);
    const columns = entries(input.columns).map(([key, raw]) => {
      const column = object(raw); keys(column, ["id", "type"]);
      if (!literal(column.id) || !literal(column.type)) throw new Error("Monday mapping requires an exact column ID and type");
      return [key, { id: column.id, type: column.type }] as const;
    });
    const groups = entries(input.groups).map(([key, id]) => {
      if (!literal(id)) throw new Error("Monday mapping requires exact group IDs");
      return [key, id] as const;
    });
    if (!columns.length && !groups.length) throw new Error("Monday mapping cannot be empty");
    if (new Set(columns.map(([, column]) => column.id)).size !== columns.length || new Set(groups.map(([, id]) => id)).size !== groups.length) {
      throw new Error("Monday mapping cannot assign multiple keys to one physical field");
    }
    mapping = { columns: Object.fromEntries(columns), groups: Object.fromEntries(groups) };
  }
  const paths = [source.identity.source_field, ...source.fields.map((field) => field.source), ...(source.parser ? [source.parser.source] : [])];
  for (const path of paths.filter((path) => path === "mapped" || path.startsWith("mapped."))) {
    if (!mapping) throw new Error("Monday mapped source fields require an Instance mapping");
    if (path === "mapped.group" && Object.keys(mapping.groups).length) continue;
    const [root, kind, key, ...rest] = path.split(".");
    if (root !== "mapped" || !["columns", "column_text", "people_principals"].includes(kind!) || !key || rest.length
      || !Object.hasOwn(mapping.columns, key)) throw new Error(`Monday mapped source field '${path}' has no exact column mapping`);
    if (kind === "people_principals" && mapping.columns[key]!.type !== "people") throw new Error("Monday mapped principals require a people column");
  }
  return mapping;
}

export function validateMondayRecordMapping(mapping: MondayRecordMapping | undefined, board: BoardSchema): void {
  if (!mapping) return;
  for (const [key, expected] of Object.entries(mapping.columns)) {
    const matches = board.columns.filter((column) => column.id === expected.id && !column.archived);
    if (matches.length !== 1 || matches[0]!.type !== expected.type) throw new Error(`Monday mapping column '${key}' no longer matches one exact active column and type`);
  }
  for (const [key, id] of Object.entries(mapping.groups)) {
    if (board.groups.filter((group) => group.id === id && !group.archived && !group.deleted).length !== 1) {
      throw new Error(`Monday mapping group '${key}' no longer matches one exact active group`);
    }
  }
}

export function mappedMondayRecordFields(mapping: MondayRecordMapping, item: {
  object_kind: string; board_id: string; group_id: string | null;
  columns: Record<string, JsonValue>; column_text: Record<string, JsonValue>;
}, rootBoardId: string, people: Record<string, JsonValue>): Record<string, JsonValue> {
  // Root mappings must never assign meaning to child-board or metadata fields.
  if (item.object_kind !== "item" || item.board_id !== rootBoardId) return {};
  const select = (values: Record<string, JsonValue>) => Object.fromEntries(Object.entries(mapping.columns)
    .filter(([, column]) => Object.hasOwn(values, column.id)).map(([key, column]) => [key, values[column.id]!]));
  return { columns: select(item.columns), column_text: select(item.column_text), people_principals: select(people),
    group: Object.entries(mapping.groups).find(([, id]) => id === item.group_id)?.[0] ?? null };
}
