import { loadArtifact } from "./artifact.ts";
import { createCompanyOSRuntimeConnectors, getBot } from "./bot.ts";
import { decodeWorkflowHostingConfiguration, workflowHostingEnabled } from "./workflow-configuration.ts";
import { createWorkflowSlackScope, qualifyWorkflowMessageInputs, qualifyWorkflowSlackConnector } from "./workflow-slack.ts";
import { WorkflowConversationHost } from "./workflow-conversations.ts";
import { WorkflowEngine } from "../../../runtime/workflow-engine/engine.ts";
import { WorkflowWorkers } from "../../../runtime/workflow-engine/workers.ts";
import { WorkflowRecordWorkers } from "../../../runtime/workflow-engine/record-workers.ts";
import { createWorkflowRecordSynchronizer } from "./workflow-records.ts";
import { DurableTimerService } from "../../../runtime/durable-timers.ts";
import { createPostgresDurableTimerStore } from "../../../state-postgres/durable-timer-store.ts";
import { createPostgresWorkflowExecutionStore } from "../../../state-postgres/workflow-store.ts";
import { createPostgresStateStore } from "../../../state-postgres/store.ts";
import { qualifyCompanyDatabase } from "../../../state-postgres/database-bootstrap.ts";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import { createHostedWorkflowConnectors } from "./workflow-connectors.ts";

export async function createWorkflowHost() {
  if (!workflowHostingEnabled()) throw new Error("Workflow hosting is disabled");
  const artifact = loadArtifact(), configuration = decodeWorkflowHostingConfiguration(artifact);
  // Qualification is read-only; starting a worker must not imply migration approval.
  await qualifyCompanyDatabase();
  const store = createPostgresWorkflowExecutionStore(), control = createPostgresStateStore();
  const timers = new DurableTimerService({ store: createPostgresDurableTimerStore(), instanceId: artifact.instance.id });
  const roster = async () => structuredClone(loadArtifact().roster), slack = createWorkflowSlackScope(getBot);
  const connectors = async (pinned: CompanyOSArtifact) => {
    return createHostedWorkflowConnectors({ artifact: pinned, enabledWorkflowIds: configuration.enabledWorkflowIds,
      create: (onlyCapabilities) => createCompanyOSRuntimeConnectors(undefined, { artifact: pinned, chat: getBot, onlyCapabilities }) })
      .map((connector) => qualifyWorkflowSlackConnector({ connector, artifact: pinned, scope: slack, roster }));
  };
  // Validate required bindings and non-secret snapshots before persisting any opening.
  await connectors(artifact);
  const engine = new WorkflowEngine({ artifact, store, control, timers, enabledWorkflowIds: configuration.enabledWorkflowIds,
    operatorPrincipals: configuration.operators.map((operator) => operator.principal), currentRoster: roster, connectors,
    qualifyMessageDestinations: (pinned, inputs) => qualifyWorkflowMessageInputs({ scope: slack, artifact: pinned, inputs, roster }),
    conversationForReceipt: ({ artifact: pinned, destinationBinding, output }) => slack(async (transport) => transport.conversation(pinned, destinationBinding, output, await roster())) });
  const workers = new WorkflowWorkers({ artifact, engine, store, timers, configuration });
  const records = new WorkflowRecordWorkers({ artifact, store, timers, enabledWorkflowIds: configuration.enabledWorkflowIds,
    recordSync: configuration.recordSync, synchronizeSource: createWorkflowRecordSynchronizer() });
  const conversations = new WorkflowConversationHost({ artifact, engine, store, control, connectors, roster, slack, enabledWorkflowIds: configuration.enabledWorkflowIds });
  return { artifact, configuration, store, engine, workers, records, conversations };
}
