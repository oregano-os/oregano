import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import type { CompanyToolContract } from "../../tool-sdk/contracts.ts";
import { resolveToolSet } from "../../toolset-resolver/resolver.ts";

const tool: CompanyToolContract = {
  grantId: "company:publish",
  runtimeId: "company:growth/publish",
  agentId: "growth",
  toolId: "publish",
  version: "1.0.0",
  description: "fixture",
  risk: "R1",
  dataClass: "business",
  idempotency: "input-hash",
  capabilities: ["artifact.publish"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  evidence: [],
  failure: "fail",
};

const resolve = (overrides: Partial<Parameters<typeof resolveToolSet>[0]> = {}) => resolveToolSet({
  agentId: "growth",
  grants: ["company:publish"],
  companyTools: [tool],
  capabilityCatalog: CORE_CAPABILITY_CATALOG,
  allowedCapabilities: ["artifact.publish"],
  bindings: [{
    capability: "artifact.publish",
    contractVersion: "1.0.0",
    connector: "fixture/artifact",
    connectorVersion: "1.0.0",
  }],
  ...overrides,
});

test("ToolSet resolution raises risk to the Capability minimum and is deterministic", () => {
  const first = resolve();
  const second = resolve();
  assert.equal(first.hash, second.hash);
  assert.equal(first.tools[0].risk, "R3");
});

test("ToolSet resolution fails closed for unknown, duplicate, unavailable, or forbidden grants", () => {
  assert.throws(() => resolve({ grants: ["company:missing"] }), /Unknown Tool grant/);
  assert.throws(() => resolve({ grants: ["company:publish", "company:publish"] }), /Duplicate Tool grant/);
  assert.throws(() => resolve({ bindings: [] }), /does not bind Capability/);
  assert.throws(() => resolve({ allowedCapabilities: [] }), /does not allow Capability/);
});
