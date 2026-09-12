import assert from "node:assert/strict";
import test from "node:test";
import { compileRecordsBuildInputs, recordsBuildTemplate, retainedRecordsBuildInputs } from "../../companyos-builder/records-build-input.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { engineArtifact } from "../workflow-engine-fixture.ts";
import type { RuntimeConnectorConfiguration } from "../../companyos-builder/types.ts";
const identity = { instanceId: "synthetic-records", coreCommit: "a".repeat(40), coreVersion: "1.0.0", workspaceCommit: "b".repeat(40), workbenchVersion: "0.1.0" };
const snapshot = { instance_id: identity.instanceId, core: { repository: "example/core", ref: identity.coreCommit, core_version: identity.coreVersion, workbench_version: identity.workbenchVersion, clean: true }, workspace: { repository: "example/workspace", ref: identity.workspaceCommit }, source_confirmations: {}, sources: [{ id: "synthetic-source" }], bindings: [{ secret_ref: "env:TEST_PROVIDER_TOKEN" }] };
const input = recordsBuildTemplate(snapshot), digest = sha256(input);
const entry: RuntimeConnectorConfiguration = { id: "records", connector: "oregano/company-records", connectorVersion: "0.1.0", configuration: { configuration_snapshot_input: digest } };

test("Records admission resolves exact build identities without changing the approved declaration or input", () => {
  const before = structuredClone({entry, input});
  const first = compileRecordsBuildInputs([entry], { [digest]: input }, identity);
  assert.deepEqual(first[0]!.configuration.configuration_snapshot, snapshot);
  assert.deepEqual({entry, input}, before);
  const artifact = engineArtifact(identity.instanceId); artifact.connectors = first;
  const retained = retainedRecordsBuildInputs(artifact);
  assert.deepEqual(retained, { [digest]: input });
  const nextIdentity = { ...identity, workspaceCommit: "c".repeat(40) };
  const next = compileRecordsBuildInputs([entry], retained, nextIdentity);
  assert.equal((next[0]!.configuration.configuration_snapshot as any).workspace.ref, nextIdentity.workspaceCommit);
  assert.equal((first[0]!.configuration.configuration_snapshot as any).workspace.ref, identity.workspaceCommit);
  assert.deepEqual((next[0]!.configuration.configuration_snapshot as any).sources, snapshot.sources);
});

test("Records admission rejects missing, altered, conflicting and cross-Instance inputs", () => {
  assert.throws(() => compileRecordsBuildInputs([entry], {}, identity), /missing/);
  assert.throws(() => compileRecordsBuildInputs([entry], { [digest]: { ...(input as any), sources: [] } }, identity), /digest/);
  const changed = recordsBuildTemplate({ ...snapshot, sources: [] });
  assert.throws(() => compileRecordsBuildInputs([entry], { [sha256(changed)]: changed }, identity), /missing/);
  assert.throws(() => compileRecordsBuildInputs([{ ...entry, configuration: { ...entry.configuration, configuration_ref: "env:CONFIG" } }], { [digest]: input }, identity), /combined/);
  assert.throws(() => compileRecordsBuildInputs([entry], { [digest]: input }, { ...identity, instanceId: "another-instance" }), /another Instance/);
  assert.throws(() => compileRecordsBuildInputs([entry], { [sha256(snapshot)]: snapshot }, identity), /placeholders/);
});

test("Records admission rejects credentials and excessive payloads before compilation", () => {
  const credential = recordsBuildTemplate({ ...snapshot, password: "synthetic-secret" });
  assert.throws(() => compileRecordsBuildInputs([entry], { [sha256(credential)]: credential }, identity), /credentials/);
  assert.throws(() => compileRecordsBuildInputs([entry], { [digest]: "x".repeat(2_000_001) }, identity), /bound/);
});

test("Existing literal snapshots and unrelated Connectors are preserved", () => {
  const literal = { ...entry, configuration: { configuration_snapshot: snapshot } };
  assert.deepEqual(compileRecordsBuildInputs([literal], {}, identity), [literal]);
  const unrelated = { ...entry, connector: "example/other" };
  assert.deepEqual(compileRecordsBuildInputs([unrelated], {}, identity), [unrelated]);
});

test("Artifact compilation pins the declaration digest while retaining the resolved snapshot", async () => {
  const { buildCompanyOSArtifact } = await import("../../companyos-builder/build.ts");
  const { join } = await import("node:path");
  const instance = {
    version: 1 as const, instanceId: identity.instanceId, environment: "test" as const, agentBindings: [], connectors: [entry],
    bindings: [
      ["artifact.publish", "oregano/artifact-sandbox"],
      ["marketing-campaign.launch", "oregano/marketing-sandbox"],
      ["marketing-campaign.read-report", "oregano/marketing-sandbox"],
      ["marketing-campaign.stop-asset", "oregano/marketing-sandbox"],
      ["conversion.record", "oregano/marketing-sandbox"],
    ].map(([capability, connector]) => ({ capability: capability!, connector: connector!, contractVersion: "1.0.0", connectorVersion: "1.0.0" })),
  };
  const args = { ...identity, instance, workspaceRoot: join(import.meta.dirname, "../fixtures/reference-company"), recordsBuildInputs: { [digest]: input } };
  const artifact = buildCompanyOSArtifact(args);
  assert.equal(artifact.provenance.instanceConfigurationDigest, sha256(instance));
  assert.deepEqual(artifact.connectors![0]!.configuration.configuration_snapshot, snapshot);
  assert.equal(JSON.stringify(artifact.connectors).includes("$build."), false);
  assert.equal(buildCompanyOSArtifact({ ...args, builtAt: "2026-09-12T00:00:00Z" }).artifactHash, artifact.artifactHash);
  assert.throws(() => buildCompanyOSArtifact({ ...args, recordsBuildInputs: {} }), /missing/);
});
