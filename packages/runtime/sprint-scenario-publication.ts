import type { CompiledSprintRuntime } from "../companyos-builder/types.ts";
import type { SprintIntent } from "../domains/sprint/contracts.ts";
import type { SprintOrchestrationStore } from "../state-store/sprint-orchestration.ts";
import type { ExecuteToolRequest } from "./companyos-runtime.ts";
import { renderSprintMessageIntent } from "./sprint-intent-renderer.ts";
import type { SprintScenarioReport } from "./sprint-scenario-runner.ts";

export interface SprintScenarioPublicationRuntime {
  execute(request: ExecuteToolRequest): Promise<unknown>;
}

export interface SprintScenarioPublicationReceipt {
  scenario_run_id: string;
  scenario_definition_id: string;
  intent_id: string;
  intent_type: "message.monday-handoff";
  output_digest: string;
  agent_id: string;
  template_path: string;
  template_digest: string;
  content_digest: string;
  slack: {
    destination_binding: string;
    message_id: string;
    thread_reference: string;
    published_at: string;
  };
}

type FridayCloseIntent = Extract<SprintIntent, {
  type: "message.close-reminder" | "message.close-chase" | "message.close-report";
}>;

export interface SprintScenarioFridayCloseMessageReceipt {
  intent_id: string;
  intent_type: FridayCloseIntent["type"];
  template_path: string;
  template_digest: string;
  content_digest: string;
  slack: {
    destination_binding: string;
    message_id: string;
    thread_reference: string;
    published_at: string;
  };
}

export interface SprintScenarioFridayClosePublicationReceipt {
  scenario_run_id: string;
  scenario_definition_id: string;
  publication_set: "friday-close";
  output_digest: string;
  agent_id: string;
  thread_reference: string;
  messages: SprintScenarioFridayCloseMessageReceipt[];
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
};

export function assertSprintScenarioPublicationDigest(report: SprintScenarioReport, expectedOutputDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(expectedOutputDigest) || report.output_digest !== expectedOutputDigest) {
    throw new Error("Sprint scenario output changed after review; run the proof-only scenario again before publication");
  }
}

/**
 * Publishes one reviewed deterministic scenario intent through the real
 * compiled Sprint Agent and its exact test-only Slack binding. The operator
 * cannot provide message text, a destination, a Tool grant, or an Agent id.
 */
export async function publishSprintScenarioMessage(args: {
  instanceId: string;
  compiled: CompiledSprintRuntime;
  report: SprintScenarioReport;
  expectedOutputDigest: string;
  intentId: string;
  store: SprintOrchestrationStore;
  runtime: SprintScenarioPublicationRuntime;
}): Promise<SprintScenarioPublicationReceipt> {
  assertSprintScenarioPublicationDigest(args.report, args.expectedOutputDigest);
  const publication = args.compiled.testPublication;
  if (!publication?.testOnly) throw new Error("Sprint scenario test publication is not compiled");
  if (args.report.source_definition_id !== args.compiled.definitionId) {
    throw new Error("Sprint scenario report does not belong to the compiled Sprint runtime");
  }
  const key = { instanceId: args.instanceId, definitionId: args.report.scenario_definition_id };
  const [stored, intents] = await Promise.all([
    args.store.getState(key),
    args.store.listIntents(key),
  ]);
  if (!stored) throw new Error("Sprint scenario state is unavailable");
  const row = intents.find((candidate) => candidate.intent.intent_id === args.intentId);
  if (!row) throw new Error("Sprint scenario intent is unavailable");
  if (row.intent.type !== "message.monday-handoff") {
    throw new Error("Only the Monday hand-off scenario is eligible for the first test-publication slice");
  }
  const rendered = renderSprintMessageIntent({
    intent: row.intent,
    state: stored.state,
    templates: args.compiled.templates,
  });
  const runId = `sprint-scenario-test-publication:${args.compiled.definitionId}:${args.report.output_digest}`;
  const envelope = object(await args.runtime.execute({
    runId,
    stepId: `publish:${row.intent.intent_id}`,
    agentId: args.compiled.agentId,
    grantId: "oregano:communications/publish",
    subjectPrincipal: args.compiled.servicePrincipal,
    input: {
      destination_binding: publication.communicationBinding,
      content: rendered.content,
      format: "provider-markdown",
    },
  }), "Sprint scenario Slack publication");
  const output = object(envelope.output, "Sprint scenario Slack publication output");
  if (output.destination_binding !== publication.communicationBinding) {
    throw new Error("Sprint scenario Slack publication receipt does not match the compiled test binding");
  }
  return {
    scenario_run_id: args.report.scenario_run_id,
    scenario_definition_id: args.report.scenario_definition_id,
    intent_id: row.intent.intent_id,
    intent_type: row.intent.type,
    output_digest: args.report.output_digest,
    agent_id: args.compiled.agentId,
    template_path: rendered.templatePath,
    template_digest: rendered.templateDigest,
    content_digest: rendered.contentDigest,
    slack: {
      destination_binding: publication.communicationBinding,
      message_id: text(output.message_id, "Slack message id"),
      thread_reference: text(output.thread_reference, "Slack thread reference"),
      published_at: text(output.published_at, "Slack published time"),
    },
  };
}

/**
 * Publishes the fixed Friday Close test sequence from one reviewed scenario.
 * The reminder opens the provider thread; chase and report are forced onto the
 * returned thread receipt. No intent id, content, destination, or thread can be
 * supplied by the operator.
 */
export async function publishSprintScenarioFridayClose(args: {
  instanceId: string;
  compiled: CompiledSprintRuntime;
  report: SprintScenarioReport;
  expectedOutputDigest: string;
  store: SprintOrchestrationStore;
  runtime: SprintScenarioPublicationRuntime;
}): Promise<SprintScenarioFridayClosePublicationReceipt> {
  assertSprintScenarioPublicationDigest(args.report, args.expectedOutputDigest);
  const publication = args.compiled.testPublication;
  if (!publication?.testOnly) throw new Error("Sprint scenario test publication is not compiled");
  if (args.compiled.execution !== "shadow-only") {
    throw new Error("Friday Close scenario publication requires a shadow-only Sprint runtime");
  }
  if (args.report.source_definition_id !== args.compiled.definitionId) {
    throw new Error("Sprint scenario report does not belong to the compiled Sprint runtime");
  }
  const key = { instanceId: args.instanceId, definitionId: args.report.scenario_definition_id };
  const [stored, intents] = await Promise.all([
    args.store.getState(key),
    args.store.listIntents(key),
  ]);
  if (!stored) throw new Error("Sprint scenario state is unavailable");
  if (intents.length !== args.report.proof_summary.intent_count) {
    throw new Error("Sprint scenario intent proof changed after review");
  }

  const sequence = ["message.close-reminder", "message.close-chase", "message.close-report"] as const;
  const rows = sequence.map((intentType) => {
    const matching = intents.filter((candidate) => candidate.intent.type === intentType);
    if (matching.length !== 1) {
      throw new Error(`Friday Close scenario requires exactly one stored '${intentType}' intent`);
    }
    const row = matching[0]!;
    if (row.state !== "succeeded") {
      throw new Error(`Friday Close scenario intent '${row.intent.intent_id}' is not succeeded`);
    }
    return row as typeof row & { intent: FridayCloseIntent };
  });

  const runId = `sprint-scenario-test-publication:${args.compiled.definitionId}:${args.report.output_digest}:friday-close`;
  const messages: SprintScenarioFridayCloseMessageReceipt[] = [];
  let threadReference: string | undefined;
  for (const [index, row] of rows.entries()) {
    const rendered = renderSprintMessageIntent({
      intent: row.intent,
      state: stored.state,
      templates: args.compiled.templates,
    });
    const envelope = object(await args.runtime.execute({
      runId,
      stepId: `publish:${row.intent.intent_id}`,
      agentId: args.compiled.agentId,
      grantId: "oregano:communications/publish",
      subjectPrincipal: args.compiled.servicePrincipal,
      input: {
        destination_binding: publication.communicationBinding,
        content: rendered.content,
        format: "provider-markdown",
        ...(index === 0 ? {} : { thread_reference: threadReference }),
      },
    }), "Sprint Friday Close Slack publication");
    const output = object(envelope.output, "Sprint Friday Close Slack publication output");
    if (output.destination_binding !== publication.communicationBinding) {
      throw new Error("Sprint Friday Close Slack receipt does not match the compiled test binding");
    }
    const outputThreadReference = text(output.thread_reference, "Slack thread reference");
    if (index === 0) threadReference = outputThreadReference;
    else if (outputThreadReference !== threadReference) {
      throw new Error("Sprint Friday Close Slack reply did not remain in the reminder thread");
    }
    messages.push({
      intent_id: row.intent.intent_id,
      intent_type: row.intent.type,
      template_path: rendered.templatePath,
      template_digest: rendered.templateDigest,
      content_digest: rendered.contentDigest,
      slack: {
        destination_binding: publication.communicationBinding,
        message_id: text(output.message_id, "Slack message id"),
        thread_reference: outputThreadReference,
        published_at: text(output.published_at, "Slack published time"),
      },
    });
  }
  if (!threadReference) throw new Error("Sprint Friday Close Slack thread is unavailable");
  return {
    scenario_run_id: args.report.scenario_run_id,
    scenario_definition_id: args.report.scenario_definition_id,
    publication_set: "friday-close",
    output_digest: args.report.output_digest,
    agent_id: args.compiled.agentId,
    thread_reference: threadReference,
    messages,
  };
}
