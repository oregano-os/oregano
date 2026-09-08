import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { buildCompanyOSArtifact } from "../companyos-builder/build.ts";
import type { WorkflowMutableState, WorkflowRunIdentity } from "../state-store/workflow-engine.ts";
import { sha256 } from "../runtime/canonical.ts";
import { workflowOriginDigest, workflowRunId } from "../runtime/workflow-engine/state-validation.ts";

export const WORKFLOW_STATE_ARTIFACT = buildCompanyOSArtifact({
  workspaceRoot: resolve(import.meta.dirname, "fixtures/lindenhof-studio"),
  instance: { version: 1, instanceId: "workflow-state-test", environment: "test", defaultAgentId: "sprint", agentBindings: [],
    bindings: ["directory.members.query", "records.query", "work-item.read", "work-item.batch-update", "communication.message.publish"].map((capability) => ({
      capability, contractVersion: CORE_CAPABILITY_CATALOG.find((contract) => contract.id === capability)!.version, connector: "test/state", connectorVersion: "1.0.0",
    })),
  },
  coreVersion: "0.5.14", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.15", builtAt: "2026-09-06T00:00:00.000Z",
});
export const WORKFLOW_STATE_NOW = "2030-01-04T12:00:00.000Z";
export function workflowStateFixture(originKey = randomUUID()) {
  const artifact = WORKFLOW_STATE_ARTIFACT;
  const workflow = artifact.workflows!.find((workflow) => workflow.id === "friday-close")!;
  const agent = artifact.agents.find((agent) => agent.id === workflow.agentId)!;
  const identity: WorkflowRunIdentity = {
    instanceId: artifact.instance.id, runId: "", workflowId: workflow.id, artifactHash: artifact.artifactHash, manifestHash: workflow.manifestHash,
    originKey, originDigest: "", subjectPrincipal: "slack:T10001:U10001", trigger: { id: "friday-close-reminder", instant: WORKFLOW_STATE_NOW, params: {} },
    fields: { sprint_id: "period-1", next_sprint_id: "period-2" }, createdAt: WORKFLOW_STATE_NOW,
  };
  identity.runId = workflowRunId(identity); identity.originDigest = workflowOriginDigest(identity);
  const state: WorkflowMutableState = { status: "running", cursor: workflow.entry, logicalInstant: WORKFLOW_STATE_NOW, steps: {}, decisions: {} };
  const meta = { runId: identity.runId, workflow: workflow.id, workflowVersion: String(workflow.version), companyCommit: artifact.provenance.workspaceCommit,
    companySnapshotHash: artifact.provenance.workspaceHash, agentDefinitionHash: sha256({ instructions: agent.instructions, materials: agent.materials }), agentAdapter: "companyos-workflow-engine", adapterVersion: "1" };
  return { artifact, identity, state, meta };
}
