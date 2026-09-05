import type { JsonValue } from "../capabilities/contracts.ts";
import type { CompanyRecordSourceDeclaration } from "./contracts.ts";

/** Non-secret Company Instance configuration. Credentials stay behind secret_ref. */
export interface CompanyRecordSourceBinding {
  schema_version: 1;
  instance_id: string;
  source_id: string;
  resource_binding: string;
  connector: string;
  connector_version: string;
  secret_ref: string;
  qualification: {
    receipt_ref: string;
    digest: string;
  };
  configuration: Record<string, JsonValue>;
}

export interface RecordSourceInventory {
  complete: true;
  observed_at: string;
  objects: Array<Record<string, JsonValue>>;
  watermark: string;
  /** Qualified complete coverage through this instant; read completion is not a substitute. */
  synced_through?: string;
  receipt: Record<string, JsonValue>;
}

/**
 * Privileged read-only boundary used by Instance synchronization workers.
 * It is not an Agent Tool and never returns a provider credential.
 */
export interface RecordSourceConnector {
  readonly id: string;
  readonly version: string;
  validateBinding(args: {
    source: CompanyRecordSourceDeclaration;
    binding: CompanyRecordSourceBinding;
    qualification: Record<string, unknown>;
  }): void;
  readCompleteInventory(args: {
    source: CompanyRecordSourceDeclaration;
    binding: CompanyRecordSourceBinding;
    qualification: Record<string, unknown>;
  }): Promise<RecordSourceInventory>;
}

export class RecordSourceConnectorRegistry {
  readonly #connectors = new Map<string, RecordSourceConnector>();

  constructor(connectors: RecordSourceConnector[] = []) {
    for (const connector of connectors) this.register(connector);
  }

  register(connector: RecordSourceConnector): void {
    const key = `${connector.id}@${connector.version}`;
    if (this.#connectors.has(key)) throw new Error(`Record Source Connector '${key}' is already registered`);
    this.#connectors.set(key, connector);
  }

  resolve(binding: CompanyRecordSourceBinding): RecordSourceConnector {
    const key = `${binding.connector}@${binding.connector_version}`;
    const connector = this.#connectors.get(key);
    if (!connector) throw new Error(`No exact Record Source Connector is registered for '${key}'`);
    return connector;
  }

  validate(source: CompanyRecordSourceDeclaration, binding: CompanyRecordSourceBinding, qualification: Record<string, unknown>): RecordSourceConnector {
    const connector = this.resolve(binding);
    connector.validateBinding({ source, binding, qualification });
    return connector;
  }
}
