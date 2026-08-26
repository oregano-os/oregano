import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadInstanceBuildConfiguration } from "../../companyos-builder/instance-loader.ts";

const withFile = (content: string, run: (path: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "companyos-instance-"));
  try {
    const path = join(root, "instance.yaml");
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("Instance build declarations load non-secret exact bindings", () => withFile(`
version: 1
instance_id: fixture-test
environment: test
bindings:
  - capability: artifact.publish
    contract_version: 1.0.0
    connector: oregano/artifact-sandbox
    connector_version: 1.0.0
`, (path) => {
  const configuration = loadInstanceBuildConfiguration(path);
  assert.equal(configuration.instanceId, "fixture-test");
  assert.equal(configuration.bindings[0]?.connector, "oregano/artifact-sandbox");
  assert.deepEqual(configuration.agentBindings, []);
}));

test("Instance build declarations reject resolved credentials", () => withFile(`
version: 1
instance_id: fixture-test
environment: test
api_key: sk-live-value-that-must-never-be-committed
bindings: []
`, (path) => {
  assert.throws(() => loadInstanceBuildConfiguration(path), /resolved credentials|credential-like assignment/);
}));

test("Instance build declarations keep Agent, execution, coding, and repository bindings separate", () => withFile(`
version: 1
instance_id: fixture-production
environment: production
bindings: []
agent_bindings:
  - id: slack-builder
    agent: builder
    surface: slack
    account_id: T1
    channel_id: C1
default_agent: oregano
builder:
  enabled: true
  execution:
    adapter: vercel-sandbox
    profile: isolated-v1
  coding_agent:
    protocol: acp-v1
    profile: codex
  repository:
    repository_id: fixture/workspace
    source_binding: github-workspace
    proposal_publisher_binding: github-workspace
`, (path) => {
  const configuration = loadInstanceBuildConfiguration(path);
  assert.deepEqual(configuration.agentBindings, [{
    id: "slack-builder",
    agentId: "builder",
    surface: "slack",
    accountId: "T1",
    channelId: "C1",
  }]);
  assert.equal(configuration.defaultAgentId, "oregano");
  assert.deepEqual(configuration.builder, {
    enabled: true,
    execution: { adapter: "vercel-sandbox", profile: "isolated-v1" },
    codingAgent: { protocol: "acp-v1", profile: "codex" },
    repository: {
      repositoryId: "fixture/workspace",
      sourceBinding: "github-workspace",
      proposalPublisherBinding: "github-workspace",
    },
  });
}));
