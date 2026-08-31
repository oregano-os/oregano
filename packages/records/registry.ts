import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration } from "./contracts.ts";

export class CompanyRecordsRegistry {
  readonly #sources = new Map<string, CompanyRecordSourceDeclaration>();
  readonly #projections = new Map<string, CompanyRecordProjectionDeclaration>();

  registerSource(source: CompanyRecordSourceDeclaration): void {
    if (this.#sources.has(source.id)) throw new Error(`Record source '${source.id}' is already registered`);
    const targets = source.fields.map((field) => field.target);
    if (new Set(targets).size !== targets.length) throw new Error(`Record source '${source.id}' contains duplicate target fields`);
    this.#sources.set(source.id, structuredClone(source));
  }

  registerProjection(projection: CompanyRecordProjectionDeclaration): void {
    if (this.#projections.has(projection.id)) throw new Error(`Record projection '${projection.id}' is already registered`);
    const names = projection.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) throw new Error(`Record projection '${projection.id}' contains duplicate field names`);
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
