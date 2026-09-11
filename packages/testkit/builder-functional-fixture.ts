import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildCompanyOSArtifact } from "../companyos-builder/build.ts";
import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { sha256 } from "../runtime/canonical.ts";
import { BuilderFunctionalTests, prepareBuilderTestSession, type BuilderTestSession, type BuilderTestStore, type BuilderTestResource } from "../runtime/builder/functional-tests.ts";
import type { BuilderJob } from "../state-store/builder-jobs.ts";

/** Fictional Workspace, real compiler and exact different source identities. */
export function builderFunctionalFixture() {
  const root = mkdtempSync(join(tmpdir(), "builder-functional-fixture-"));
  cpSync(resolve(import.meta.dirname, "fixtures/lindenhof-studio"), root, { recursive: true });
  mkdirSync(join(root, "agents/test-publisher"), { recursive: true });
  mkdirSync(join(root, "agents/test-reader"), { recursive: true });
  writeFileSync(join(root, "agents/test-publisher/instructions.md"), `---
description: Publish the exact bounded test report.
tools: [oregano:work-items/comment]
scope:
  read: [company.md, policies/**, workflows/builder-proof.md]
---
# Test publisher
Publish only the declared comment.
`);
  writeFileSync(join(root, "agents/test-reader/instructions.md"), `---
description: Read-only Agent used in the synthetic functional-test fixture.
tools: []
scope:
  read: [company.md]
---
# Test reader
Answer concisely from the available company material.
`);
  const build = (revision: "a" | "b", body: string) => {
    writeFileSync(join(root, "workflows/builder-proof.md"), `---
type: workflow
id: builder-proof
version: ${revision === "a" ? 1 : 2}
owner: agents/test-publisher
execution_mode: unattended
trigger: operator
instance:
  key: [trigger_id, run_date]
  fields: [trigger_id, run_date]
steps:
  - publish-note: oregano:work-items/comment
    input: { resource_binding: designated-test-board, work_item_id: "42", body: "${body}" }
    then: end
---
# Test report

1. [test-publisher, R2] Publish the exact test note. <!-- step:publish-note -->
`);
    return buildCompanyOSArtifact({ workspaceRoot: root,
      instance: { version: 1, instanceId: "functional-example", environment: "test", defaultAgentId: "sprint", agentBindings: [],
        bindings: ["directory.members.query", "records.query", "work-item.read", "work-item.comment", "work-item.batch-update", "communication.message.publish"].map((capability) => ({
          capability, contractVersion: CORE_CAPABILITY_CATALOG.find((entry) => entry.id === capability)!.version, connector: "test/engine", connectorVersion: "1.0.0",
        })), workflowBindings: { directRecipients: ["jonas-owner", "lea-contributor", "tim-contributor"].map((memberId) => ({ bindingId: "sprint-direct", memberId, destinationBinding: `direct-${memberId}` })) },
      }, coreVersion: "0.8.0", coreCommit: "c".repeat(40), workspaceCommit: revision.repeat(40),
      workbenchVersion: "0.1.0-experimental.18", builtAt: "2026-09-08T12:00:00Z" });
  };
  const previous = build("a", "Original report."), candidate = build("b", "Summary first. Then the task list.");
  const resources: BuilderTestResource[] = [{ id: "test-board", capability: "work-item.comment", match: { resource_binding: "designated-test-board", work_item_id: "42" } },
    { id: "test-channel", capability: "communication.message.publish", match: { destination_binding: "test-channel" } }];
  const job = { jobId: "builder-functional-example", instanceId: previous.instance.id, repositoryId: "example/company", requesterPrincipal: "slack:T10001:U10001",
    objective: "Build a concise answer", sourceConversationKey: "slack:C10001:1.0", baseCommit: previous.provenance.workspaceCommit, state: "published",
    brief: { artifactHash: previous.artifactHash, digest: "e".repeat(64), brief: { deploymentIntent: "after-acceptance", proposedBehavior: "Summary precedes the task list.",
      test: { strategy: "test-resources", targetBindings: resources.map((resource) => resource.id), execution: { kind: "workflow", workflowId: "builder-proof", fields: {} } } } },
    evidence: { proposal: { jobId: "builder-functional-example", repositoryId: "example/company", baseCommit: previous.provenance.workspaceCommit, proposalCommit: candidate.provenance.workspaceCommit },
      validation: { validationPassed: true, releaseChangeClass: "behavior", checks: [{ id: "validate", evidenceDigest: "f".repeat(64) }] } },
  } as unknown as BuilderJob;
  const session = prepareBuilderTestSession({ job, coreCommit: candidate.provenance.coreCommit, resources, execution: job.brief!.brief.test.execution! });
  const values = new Map<string, BuilderTestSession>();
  const store: BuilderTestStore = {
    get: async (id) => structuredClone(values.get(id)),
    create: async (value) => { if (!values.has(value.id)) values.set(value.id, structuredClone(value)); return structuredClone(values.get(value.id)!); },
    replace: async (old, next) => { if (sha256(values.get(old.id)) !== sha256(old)) return false; values.set(old.id, structuredClone(next)); return true; },
  };
  return { previous, candidate, job, session, resources, store, tests: new BuilderFunctionalTests(store), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
