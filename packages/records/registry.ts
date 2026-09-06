import type { CompanyRecordProjectionDeclaration, CompanyRecordSourceDeclaration } from "./contracts.ts";
import { validateRecordFilters } from "./query.ts";
import { validateRecordSource } from "./source-validation.ts";
import { normalizeRecordObject } from "./normalize.ts";
import type { RecordIdentityDirectory } from "./identity-directory.ts";
import { sha256 } from "../runtime/canonical.ts";
import { recordSourceBindingDigest, type CompanyRecordSourceBinding } from "./source-connector.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import { createRecordGenerationStore } from "./generation-store.ts";

export class CompanyRecordsRegistry {
  readonly #sources = new Map<string, CompanyRecordSourceDeclaration>();
  readonly #projections = new Map<string, CompanyRecordProjectionDeclaration>();
  readonly #bindings = new Map<string, { digest: string; instanceId: string }>();
  readonly #stores = new WeakMap<CompanyRecordsStore, CompanyRecordsStore>();
  #frozen = false;
  readonly identities?: RecordIdentityDirectory;

  constructor(options: { identities?: RecordIdentityDirectory } = {}) {
    this.identities = options.identities;
  }

  sourceDigest(id: string): string {
    const source = this.source(id);
    const resolvesIdentity = source.fields.some((field) => field.resolve_identity);
    if (resolvesIdentity && !this.identities) throw new Error(`Record source '${id}' requires a frozen roster identity directory`);
    const bindingDigest = this.sourceBindingDigest(id);
    if (!resolvesIdentity && !bindingDigest) return sha256(source);
    return sha256({ source, ...(resolvesIdentity ? { identity_directory_digest: this.identities!.digest } : {}),
      ...(bindingDigest ? { binding_digest: bindingDigest } : {}) });
  }

  /** Call after Connector qualification validation; no provider credential enters this registry. */
  bindSource(binding: CompanyRecordSourceBinding, qualification: Record<string, unknown>): void {
    if (this.#frozen) throw new Error("A bound Records registry is frozen after storage use");
    const source = this.source(binding.source_id);
    if (source.resource_binding !== binding.resource_binding || !binding.instance_id) throw new Error("Record source binding does not match its declaration or Instance");
    if (this.#bindings.has(source.id)) throw new Error(`Record source '${source.id}' is already bound`);
    this.#bindings.set(source.id, { digest: recordSourceBindingDigest(binding, qualification), instanceId: binding.instance_id });
  }

  sourceBindingDigest(id: string): string | undefined { return this.#bindings.get(id)?.digest; }

  sourceStorageId(id: string): string {
    this.source(id);
    return this.sourceBindingDigest(id) ? `records-source:v1:${sha256({ id, digest: this.sourceDigest(id) })}` : id;
  }

  projectionStorageId(id: string): string {
    const definition = this.projection(id);
    const sources = this.projectionSourceIds(id);
    return sources.some((sourceId) => this.sourceBindingDigest(sourceId)) ? `records-projection:v1:${sha256(definition)}` : id;
  }

  projectionSourceIds(id: string): string[] {
    const definition = this.projection(id);
    return definition.source_ids ?? this.sourceForRecordType(definition.record_type).map((value) => value.id);
  }

  scopeStore(store: CompanyRecordsStore): CompanyRecordsStore {
    if (!this.#bindings.size) return store;
    this.#frozen = true;
    const cached = this.#stores.get(store);
    if (cached) return cached;
    const scoped = createRecordGenerationStore(this, store);
    this.#stores.set(store, scoped); this.#stores.set(scoped, scoped);
    return scoped;
  }

  assertSourceInstance(id: string, instanceId: string): void {
    const binding = this.#bindings.get(id);
    if (binding && binding.instanceId !== instanceId) throw new Error(`Record source '${id}' is bound to another Company Instance`);
  }

  normalize(args: Parameters<typeof normalizeRecordObject>[0]) {
    this.assertSourceInstance(args.source.id, args.instanceId);
    const bound = this.sourceBindingDigest(args.source.id) !== undefined;
    if (bound && sha256(args.source) !== sha256(this.source(args.source.id))) throw new Error("Normalization source differs from its registered declaration");
    return normalizeRecordObject({ ...args, identities: this.identities,
      sourceDigest: bound ? this.sourceDigest(args.source.id) : undefined });
  }

  registerSource(source: CompanyRecordSourceDeclaration): void {
    if (this.#frozen) throw new Error("A bound Records registry is frozen after storage use");
    if (this.#sources.has(source.id)) throw new Error(`Record source '${source.id}' is already registered`);
    const targets = source.fields.map((field) => field.target);
    if (new Set(targets).size !== targets.length) throw new Error(`Record source '${source.id}' contains duplicate target fields`);
    validateRecordSource(source);
    this.#sources.set(source.id, structuredClone(source));
  }

  registerProjection(projection: CompanyRecordProjectionDeclaration): void {
    if (this.#frozen) throw new Error("A bound Records registry is frozen after storage use");
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
