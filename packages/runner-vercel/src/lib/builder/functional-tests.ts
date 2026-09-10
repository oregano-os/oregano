import type { Author, Chat, StateAdapter } from "chat";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import type { BuilderJob } from "../../../../state-store/builder-jobs.ts";
import type { BuilderTerminalNotifier } from "../../../../runtime/builder/notifications.ts";
import { BuilderFunctionalTests, type BuilderTestSession, type BuilderTestResult } from "../../../../runtime/builder/functional-tests.ts";
import { createBuilderFunctionalTestIntegration as createCoreIntegration } from "../../../../runtime/builder/test-integration.ts";
import { assertBuilderTestSupported } from "./functional-test-execution.ts";
import { createWorkflowSlackScope } from "../workflow-slack.ts";
import type { BuilderCardPresenter } from "./card-presenter.ts";
import { renderBuilderCard } from "./result-card.ts";
import type { BuilderTestSurface } from "../../../../runtime/builder/experience.ts";
export { builderProposalFeedbackKey, builderProposalDecisionKey, builderProposalFeedbackConversation, builderFeedbackKey } from "../../../../runtime/builder/test-integration.ts";

/** Slack-specific addressing is confined to this communication adapter. */
export function createSlackBuilderTestSurface(artifact: CompanyOSArtifact, chat: Chat): BuilderTestSurface {
  const destination = (id: string) => {
    const entries = (artifact.connectors ?? []).flatMap(connector => connector.connector === "oregano/slack-communication"
      && Array.isArray(connector.configuration.destinations) ? connector.configuration.destinations : []);
    const binding = entries.find(entry => entry && typeof entry === "object" && !Array.isArray(entry) && entry.id === id) as { kind?: string; channel_id?: string; account_id?: string } | undefined;
    if (binding?.kind !== "channel" || !binding.channel_id) throw new Error("This test destination is not a configured channel.");
    return { channel: `slack:${binding.channel_id}`, label: id,
      url: binding.account_id ? `https://app.slack.com/client/${binding.account_id}/${binding.channel_id}` : `https://slack.com/app_redirect?channel=${binding.channel_id}` };
  };
  return { destination,
    contains: (binding, conversation) => conversation.startsWith(`${destination(binding).channel}:`),
    isRoot: (conversation, messageId) => conversation.split(":").at(-1) === messageId,
    qualify: async binding => { await createWorkflowSlackScope(() => chat)(async scope => { await scope.qualify(artifact, binding, artifact.roster); }); },
    permalink: conversation => createWorkflowSlackScope(() => chat)(scope => scope.permalink(conversation)),
  };
}

export function createBuilderFunctionalTestIntegration(args: {
  artifact: CompanyOSArtifact; chat: Chat; state: StateAdapter; tests: BuilderFunctionalTests;
  authenticatedPrincipal(author: Author): string | undefined;
  getJob(jobId: string): Promise<BuilderJob | undefined>;
  present?: BuilderCardPresenter;
  compile(job: BuilderJob): Promise<CompanyOSArtifact>;
  execute(artifact: CompanyOSArtifact, session: BuilderTestSession): Promise<BuilderTestResult>;
  ready: BuilderTerminalNotifier; fallback: BuilderTerminalNotifier;
  transport?: Partial<BuilderTestSurface>;
}) {
  const thread = (id: string) => ({ id,
    post: async (content: string | Parameters<typeof renderBuilderCard>[0]) => args.chat.thread(id).post(typeof content === "string" ? content : renderBuilderCard(content)),
    subscribe: async () => { await args.chat.thread(id).subscribe(); },
  });
  return createCoreIntegration({ ...args, assertSupported: assertBuilderTestSupported,
    transport: { ...createSlackBuilderTestSurface(args.artifact, args.chat), ...args.transport },
    present: args.present ? (job, model, phase) => args.present!(job, renderBuilderCard(model), phase) : undefined,
    chat: { thread,
      channel: id => ({ post: async content => args.chat.channel(id).post(typeof content === "string" ? content : renderBuilderCard(content)) }),
      onAction: (id, handler) => { args.chat.onAction(id, event => handler({ user: event.user, value: event.value, thread: event.thread ? thread(event.thread.id) : undefined })); },
    },
  });
}
