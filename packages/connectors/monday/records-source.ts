import { createHash } from "node:crypto";
import type { JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration } from "../../records/contracts.ts";
import type {
  CompanyRecordSourceBinding,
  RecordSourceConnector,
  RecordSourceInventory,
} from "../../records/source-connector.ts";
import { MondayClient, type MondayFetch } from "./client.ts";

export const MONDAY_RECORD_SOURCE_CONNECTOR_ID = "oregano/monday-record-source";
export const MONDAY_RECORD_SOURCE_CONNECTOR_VERSION = "0.1.0";
export const MONDAY_RECORD_SOURCE_API_VERSION = "2026-07";

const object = (value: JsonValue | undefined, label: string): Record<string, JsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const string = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
};

const integer = (value: JsonValue | undefined, label: string, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const configuredColumnIds = (source: CompanyRecordSourceDeclaration): string[] => {
  const paths = [source.identity.source_field, ...source.fields.map((field) => field.source)];
  const ids = paths.flatMap((path) => {
    const [root, id] = path.split(".");
    return (root === "columns" || root === "column_text") && id ? [id] : [];
  });
  return [...new Set(ids)].sort();
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const mondayConfiguration = (
  source: CompanyRecordSourceDeclaration,
  binding: CompanyRecordSourceBinding,
  qualification: Record<string, unknown>,
) => {
  if (binding.source_id !== source.id) throw new Error(`Record binding source '${binding.source_id}' does not match declaration '${source.id}'`);
  if (binding.resource_binding !== source.resource_binding) {
    throw new Error(`Record binding resource '${binding.resource_binding}' does not match declaration '${source.resource_binding}'`);
  }
  const configuration = object(binding.configuration, "Monday record-source configuration");
  const apiVersion = string(configuration.api_version, "Monday api_version");
  if (apiVersion !== MONDAY_RECORD_SOURCE_API_VERSION) {
    throw new Error(`Maintained Monday record-source Connector requires API version '${MONDAY_RECORD_SOURCE_API_VERSION}'`);
  }
  const boardId = string(configuration.board_id, "Monday board_id");
  if (!/^\d{1,20}$/.test(boardId)) throw new Error(`Monday board id '${boardId}' is invalid`);
  const groupIds = configuration.group_ids === undefined
    ? []
    : Array.isArray(configuration.group_ids)
      ? configuration.group_ids.map((value, index) => string(value, `Monday group_ids[${index}]`))
      : (() => { throw new Error("Monday group_ids must be an array"); })();
  const pageSize = integer(configuration.page_size, "Monday page_size", 100, 1, 500);
  const maxPages = integer(configuration.max_pages, "Monday max_pages", 100, 1, 1000);
  const qualified = qualification as any;
  if (qualified?.kind !== "monday-read-qualification" || qualified?.phase !== "complete") {
    throw new Error("Monday record-source binding requires one complete Monday qualification receipt");
  }
  const discovery = qualified?.evidence?.discovery;
  if (!discovery || discovery.discovery_hash !== binding.qualification.digest) {
    throw new Error("Monday qualification digest does not match the Instance binding");
  }
  if (discovery.credentials_retained !== false) throw new Error("Monday qualification does not prove credential disposal");
  const scopes = [...new Set((discovery.scopes ?? []).map(String))].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(["boards:read", "me:read"])) {
    throw new Error("Monday qualification does not contain the exact read-only scopes");
  }
  const board = (discovery.boards ?? []).find((candidate: any) => String(candidate.id) === boardId);
  if (!board) throw new Error(`Monday qualification does not contain exact board '${boardId}'`);
  const qualifiedGroups = new Set((board.groups ?? []).filter((group: any) => !group.archived && !group.deleted).map((group: any) => String(group.id)));
  for (const groupId of groupIds) if (!qualifiedGroups.has(groupId)) throw new Error(`Monday group '${groupId}' is not active in the qualified board evidence`);
  const qualifiedColumns = new Set((board.columns ?? []).filter((column: any) => !column.archived).map((column: any) => String(column.id)));
  for (const columnId of configuredColumnIds(source)) {
    if (!qualifiedColumns.has(columnId)) throw new Error(`Monday column '${columnId}' is not active in the qualified board evidence`);
  }
  return { apiVersion, boardId, groupIds, pageSize, maxPages };
};

export class MondayRecordSourceConnector implements RecordSourceConnector {
  readonly id = MONDAY_RECORD_SOURCE_CONNECTOR_ID;
  readonly version = MONDAY_RECORD_SOURCE_CONNECTOR_VERSION;
  readonly resolveSecret: (secretRef: string) => string;
  readonly fetcher?: MondayFetch;
  readonly now: () => Date;

  constructor(args: {
    resolveSecret: (secretRef: string) => string;
    fetcher?: MondayFetch;
    now?: () => Date;
  }) {
    this.resolveSecret = args.resolveSecret;
    this.fetcher = args.fetcher;
    this.now = args.now ?? (() => new Date());
  }

  validateBinding(args: { source: CompanyRecordSourceDeclaration; binding: CompanyRecordSourceBinding; qualification: Record<string, unknown> }): void {
    mondayConfiguration(args.source, args.binding, args.qualification);
  }

  async readCompleteInventory(args: {
    source: CompanyRecordSourceDeclaration;
    binding: CompanyRecordSourceBinding;
    qualification: Record<string, unknown>;
  }): Promise<RecordSourceInventory> {
    const { source, binding, qualification } = args;
    const { apiVersion, boardId, groupIds, pageSize, maxPages } = mondayConfiguration(source, binding, qualification);
    const token = this.resolveSecret(binding.secret_ref);
    if (!token) throw new Error(`Record Source Connector secret '${binding.secret_ref}' is unavailable`);
    const client = new MondayClient({ token, apiVersion, ...(this.fetcher ? { fetcher: this.fetcher } : {}) });
    const columnIds = configuredColumnIds(source);
    const inventory = await client.readCompleteRecordInventory({ boardId, columnIds, groupIds, pageSize, maxPages });
    const observedAt = this.now().toISOString();
    const objects: Array<Record<string, JsonValue>> = inventory.objects.map((item) => ({
      id: item.id,
      name: item.name,
      updated_at: item.updated_at,
      board_id: item.board_id,
      group_id: item.group_id,
      columns: item.columns,
      column_text: item.column_text,
    }));
    const inventoryDigest = digest(objects);
    return {
      complete: true,
      observed_at: observedAt,
      objects,
      watermark: `monday:${inventoryDigest}`,
      receipt: {
        connector: this.id,
        connector_version: this.version,
        api_version_requested: apiVersion,
        api_versions_reported: inventory.reportedApiVersions,
        request_ids: inventory.requestIds,
        resource_binding: binding.resource_binding,
        board_id: boardId,
        group_ids: groupIds,
        column_ids: columnIds,
        pages: inventory.pageCount,
        objects: objects.length,
        inventory_digest: inventoryDigest,
        complete: true,
        credentials_retained: false,
      },
    };
  }
}
