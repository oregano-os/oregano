import assert from "node:assert/strict";
import { test } from "node:test";
import { builderFunctionalFixture } from "../builder-functional-fixture.ts";
import { createHostedWorkflowConnectors } from "../../runner-vercel/src/lib/workflow-connectors.ts";

test("a comment-only hosted workflow ignores an unrelated environment-bound Records Connector", () => {
  const f = builderFunctionalFixture();
  try {
    const artifact = structuredClone(f.candidate);
    artifact.connectors = [{ id: "records", connector: "oregano/company-records", connectorVersion: "0.1.0", configuration: { configuration_ref: "env:UNAVAILABLE_RECORDS" } }];
    artifact.bindings = artifact.bindings.map((binding) => binding.capability === "records.query" ? { ...binding, connector: "oregano/company-records", connectorVersion: "0.1.0" } : binding);
    let selected: string[] = [];
    createHostedWorkflowConnectors({ artifact, enabledWorkflowIds: ["builder-proof"], create: (capabilities) => { selected = capabilities; return []; } });
    assert.deepEqual(selected, ["work-item.comment"]);
    const recordsOwner = artifact.agents.find((agent) => agent.tools.some((tool) => tool.contract.capabilities.includes("records.query")))!;
    artifact.workflows!.find((workflow) => workflow.id === "builder-proof")!.agentId = recordsOwner.id;
    let constructed = false;
    assert.throws(() => createHostedWorkflowConnectors({ artifact, enabledWorkflowIds: ["builder-proof"], create: () => { constructed = true; return []; } }), /configuration_snapshot/);
    assert.equal(constructed, false, "actual Records users still need an immutable snapshot before host initialization");
    artifact.connectors[0]!.configuration = { configuration_snapshot: { synthetic: true } };
    createHostedWorkflowConnectors({ artifact, enabledWorkflowIds: ["builder-proof"], create: (capabilities) => { selected = capabilities; return []; } });
    assert.ok(selected.includes("records.query"));
  } finally { f.cleanup(); }
});
