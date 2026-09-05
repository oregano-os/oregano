import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { CompanyDirectoryConnector } from "../../connectors/company-directory.ts";
import { RecordIdentityDirectory } from "../../records/identity-directory.ts";
import { CompanyOSRuntime } from "../../runtime/companyos-runtime.ts";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-directory-"));
  cpSync(join(import.meta.dirname, "../fixtures/reference-company"), root, { recursive: true });
  const agentPath = join(root, "agents/growth/instructions.md");
  const connectionPath = join(root, "connections/marketing.md");
  writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace("  - company:stop-asset\n", "  - company:stop-asset\n  - oregano:directory/members\n"));
  writeFileSync(connectionPath, readFileSync(connectionPath, "utf8").replace("  - conversion.record\n", "  - conversion.record\n  - directory.members.query\n"));
  const instance: InstanceBuildConfiguration = {
    version: 1, instanceId: "directory-fixture", environment: "test", agentBindings: [],
    bindings: [
      ...["artifact.publish", "marketing-campaign.launch", "marketing-campaign.read-report", "marketing-campaign.stop-asset", "conversion.record"]
        .map((capability) => ({ capability, contractVersion: "1.0.0", connector: "fixture/sandbox", connectorVersion: "1.0.0" })),
      { capability: "directory.members.query", contractVersion: "1.0.0", connector: "oregano/company-directory", connectorVersion: "1.0.0" },
    ],
    connectors: [{ id: "reviewed-directory", connector: "oregano/company-directory", connectorVersion: "1.0.0", configuration: { read_groups: ["role:steward"] } }],
  };
  const build = () => buildCompanyOSArtifact({ workspaceRoot: root, instance, coreVersion: "0.5.14", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.15" });
  return { root, build, instance, agentPath };
};
const request = { runId: "directory-read", stepId: "directory", agentId: "growth", grantId: "oregano:directory/members", input: {}, subjectPrincipal: "test:solstice:avery" };

test("the directory standard Tool executes through the real compiler, sandbox, runtime and access checks", async () => {
  const setup = fixture();
  try {
    const artifact = setup.build();
    const state = new InMemoryStateStore();
    const connector = new CompanyDirectoryConnector({ instanceId: artifact.instance.id, roster: artifact.roster, readGroups: ["role:steward"] });
    const runtime = new CompanyOSRuntime({ artifact, state, connectors: [connector] });
    const result: any = await runtime.execute(request);
    assert.equal(result.output.directory_digest, new RecordIdentityDirectory(artifact.roster).digest);
    assert.equal(result.output.members.length, 3);
    assert.ok(result.output.members.some((member: any) => member.principals.includes("test:solstice:avery")));
    assert.doesNotMatch(JSON.stringify(result.output), /mayApprove|may_approve|\"role\":/);
    assert.equal(state.effects.size, 0);
    assert.ok(state.events.some((event) => event.event === "tool.read-succeeded"));
    const originalName = result.output.members[0].display_name;
    result.output.members[0].display_name = "Changed outside";
    artifact.roster.forEach((member) => { member.name = "Mutated Artifact object"; });
    assert.equal(((await runtime.execute(request)) as any).output.members[0].display_name, originalName);
    for (const principal of [undefined, "test:solstice:unknown", "test:solstice:morgan"]) {
      await assert.rejects(() => runtime.execute({ ...request, subjectPrincipal: principal }), /directory access denied/);
    }
    const inactive = new CompanyOSRuntime({ artifact, state, connectors: [connector], roster: artifact.roster.map((member) => ({ ...member, status: "inactive" })) });
    await assert.rejects(() => inactive.execute(request), /directory access denied/);
    await assert.rejects(() => runtime.execute({ ...request, input: { group_ids: ["role:steward"] } }), /Invalid Tool input/);
    assert.equal(state.effects.size, 0);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("directory installation never substitutes for the explicit Agent grant or Capability binding", async () => {
  const setup = fixture();
  try {
    writeFileSync(setup.agentPath, readFileSync(setup.agentPath, "utf8").replace("  - oregano:directory/members\n", ""));
    const artifact = setup.build();
    const runtime = new CompanyOSRuntime({ artifact, state: new InMemoryStateStore(), connectors: [new CompanyDirectoryConnector({ instanceId: artifact.instance.id, roster: artifact.roster, readGroups: ["role:steward"] })] });
    await assert.rejects(() => runtime.execute(request), /not in agent.*ToolSet/);
    writeFileSync(setup.agentPath, readFileSync(setup.agentPath, "utf8").replace("  - company:stop-asset\n", "  - company:stop-asset\n  - oregano:directory/members\n"));
    setup.instance.bindings = setup.instance.bindings.filter((binding) => binding.capability !== "directory.members.query");
    assert.throws(() => setup.build(), /does not bind Capability/);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test("directory reads refuse cross-Instance access and an absent read policy", async () => {
  assert.throws(() => new CompanyDirectoryConnector({ instanceId: "fixture", roster: [], readGroups: [] }), /explicit read groups/);
  const connector = new CompanyDirectoryConnector({ instanceId: "one", roster: [], readGroups: ["delivery"] });
  await assert.rejects(() => connector.invoke("directory.members.query", {}, {
    instanceId: "two", runId: "run", stepId: "read", agentId: "agent", toolId: "directory",
    subject: { principalId: "test:example:person", principalType: "human", status: "active", groupIds: ["delivery"] },
  }), /directory access denied/);
});
