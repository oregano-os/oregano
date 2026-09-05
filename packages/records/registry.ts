import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration } from "./contracts.ts";
import { validateRecordFilters } from "./query.ts";
import { validateRecordSource } from "./source-validation.ts";
import { normalizeRecordObject } from "./normalize.ts";
import type { RecordIdentityDirectory } from "./identity-directory.ts";
import { sha256 } from "../runtime/canonical.ts";

export class CompanyRecordsRegistry {
  readonly #sources = new Map<string, CompanyRecordSourceDeclaration>();
  readonly #projections = new Map<string, CompanyRecordProjectionDeclaration>();
  readonly identities?: RecordIdentityDirectory;

  constructor(options: { identities?: RecordIdentityDirectory } = {}) {
    this.identities = options.identities;
  }

  sourceDigest(id: string): string {
    const source = this.source(id);
    if (!source.fields.some((field) => field.resolve_identity)) return sha256(source);
    if (!this.identities) throw new Error(`Record source '${id}' requires a frozen roster identity directory`);
    return sha256({ source, identity_directory_digest: this.identities.digest });
  }

  normalize(args: Parameters<typeof normalizeRecordObject>[0]) {
    return normalizeRecordObject({ ...args, identities: this.identities });
  }

  registerSource(source: CompanyRecordSourceDeclaration): void {
    if (this.#sources.has(source.id)) throw new Error(`Record source '${source.id}' is already registered`);
    const targets = source.fields.map((field) => field.target);
    if (new Set(targets).size !== targets.length) throw new Error(`Record source '${source.id}' contains duplicate target fields`);
    validateRecordSource(source);
    this.#sources.set(source.id, structuredClone(source));
  }

  registerProjection(projection: CompanyRecordProjectionDeclaration): void {
    if (this.#projections.has(projection.id)) throw new Error(`Record projection '${projection.id}' is already registered`);
    const names = projection.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) throw new Error(`Record projection '${projection.id}' contains duplicate field names`);
    if (projection.source_ids && (!projection.source_ids.length || new Set(projection.source_ids).size !== projection.source_ids.length)) {
      throw new Error(`Record projection '${projection.id}' requires distinct source identities`);
    }
    validateRecordFilters(projection);
    this.#projections.set(projection.id, structuredClone(projection));
  }

  source(id: string): CompanyRecordSourceDeclaration {
    const value = this.#sources.get(id);
    if (!value) throw new Error(`Unknown record source '${id}'`);
    return structuredClone(value);
  }

  projection(id: string): CompanyRecordProjectionDeclaration {
    const value = this.#projections.get(id);
    if (!value) throw new Error(`Unknown record projection '${id}'`);
    return structuredClone(value);
  }

  sourceForRecordType(recordType: string): CompanyRecordSourceDeclaration[] {
    return [...this.#sources.values()].filter((source) => source.record_type === recordType).map((value) => structuredClone(value));
  }

  projectionsForRecordType(recordType: string): CompanyRecordProjectionDeclaration[] {
    return [...this.#projections.values()].filter((projection) => projection.record_type === recordType).map((value) => structuredClone(value));
  }
}
