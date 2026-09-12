import type { JsonValue } from "../capabilities/contracts.ts";
import type { RuntimeConnectorConfiguration, CompanyOSArtifact } from "./types.ts";
import { sha256 } from "../runtime/canonical.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";

export type RecordsBuildInputs = Record<string, JsonValue>;
const object = (value: unknown): Record<string, JsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Records build input must be an object.");
  return value as Record<string, JsonValue>;
};
function noCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|database[_-]?url|password|passwd|private[_-]?key|secret|token)$/i.test(key)) throw new Error("Records build inputs must contain SecretRefs, never credentials.");
    noCredentials(child);
  }
}
/** Identity placeholders avoid storing a Git commit inside that same commit. */
export function recordsBuildTemplate(snapshot: JsonValue): JsonValue {
  const result = structuredClone(object(snapshot));
  const core = object(result.core), workspace = object(result.workspace);
  core.ref = "$build.core_commit";
  core.core_version = "$build.core_version";
  core.workbench_version = "$build.workbench_version";
  workspace.ref = "$build.workspace_commit";
  return result;
}
export function validateRecordsBuildInputs(inputs: RecordsBuildInputs): void {
  object(inputs);
  if (Object.keys(inputs).length > 20 || JSON.stringify(inputs).length > 2_000_000) throw new Error("Records build inputs exceed their bound.");
  noCredentials(inputs);
  if (scanCredentialIndicators(JSON.stringify(inputs)).length) throw new Error("Records build inputs contain credential indicators.");
  for (const [digest, input] of Object.entries(inputs)) {
    if (!/^[a-f0-9]{64}$/.test(digest) || sha256(input) !== digest || sha256(recordsBuildTemplate(input)) !== digest) throw new Error("Records build input digest or identity placeholders do not match.");
  }
}
export function compileRecordsBuildInputs(connectors: RuntimeConnectorConfiguration[], inputs: RecordsBuildInputs, identity: {
  instanceId: string; coreCommit: string; coreVersion: string; workspaceCommit: string; workbenchVersion: string;
}): RuntimeConnectorConfiguration[] {
  validateRecordsBuildInputs(inputs);
  return connectors.map(entry => {
    if (entry.connector !== "oregano/company-records" || entry.configuration.configuration_snapshot_input === undefined) return structuredClone(entry);
    if (Object.keys(entry.configuration).length !== 1) throw new Error("Records snapshot input cannot be combined with another configuration source.");
    const digest = entry.configuration.configuration_snapshot_input;
    if (typeof digest !== "string" || !Object.hasOwn(inputs, digest)) throw new Error("The approved Records build input is missing.");
    const snapshot = structuredClone(object(inputs[digest]));
    if (snapshot.instance_id !== identity.instanceId) throw new Error("Records build input belongs to another Instance.");
    const core = object(snapshot.core), workspace = object(snapshot.workspace);
    core.ref = identity.coreCommit; core.core_version = identity.coreVersion; core.workbench_version = identity.workbenchVersion;
    workspace.ref = identity.workspaceCommit;
    return { ...structuredClone(entry), configuration: { configuration_snapshot: snapshot } };
  });
}
/** Subsequent governed builds reuse the approved, retained input; no provider lookup. */
export function retainedRecordsBuildInputs(artifact: CompanyOSArtifact): RecordsBuildInputs {
  const inputs: RecordsBuildInputs = {};
  for (const entry of artifact.connectors ?? []) {
    if (entry.connector !== "oregano/company-records" || !entry.configuration.configuration_snapshot) continue;
    const input = recordsBuildTemplate(entry.configuration.configuration_snapshot);
    inputs[sha256(input)] = input;
  }
  validateRecordsBuildInputs(inputs);
  return inputs;
}
