import type { Author, Chat, StateAdapter } from "chat";
import { ReleaseCoordinator } from "../../../../runtime/release/coordinator.ts";
import { createPostgresReleasePrivateState, createPostgresReleaseRunStore } from "../../../../state-postgres/release-run-store.ts";
import { VercelProductionReleaseHost, type VercelReleaseBinding } from "../../../../connectors/vercel-release.ts";
import { loadArtifact } from "../artifact.ts";
import { getGitHubRepositoryProvider, getTrustedGitExecution } from "./provider-factory.ts";
import { HostedBuilderReleaseAdapter } from "./live-release-adapter.ts";
import { createBuilderReleaseIntegration } from "./release-integration.ts";
import { createBuilderChatNotifier } from "./chat-notifier.ts";
import { createPostgresKnowledgeProvider } from "../../../../state-postgres/knowledge-store.ts";
import { createPostgresWorkflowExecutionStore } from "../../../../state-postgres/workflow-store.ts";

export function builderInstanceYaml(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const encoded = environment.COMPANYOS_BUILDER_INSTANCE_YAML_BASE64;
  if (!encoded) return undefined;
  if (encoded.length > 1000000) throw new Error("Builder Instance binding exceeds its bound.");
  return Buffer.from(encoded, "base64").toString("utf8");
}
export function builderConfigurationDigest(): string | undefined {
  return loadArtifact().provenance.instanceConfigurationDigest;
}
export function createBuilderReleaseRuntime(args: {
  chat: Chat; state: StateAdapter; authenticatedPrincipal(author: Author): string | undefined;
}) {
  const artifact = loadArtifact();
  const bindingValue = process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64;
  if (!bindingValue) return undefined;
  if (!artifact.builder || !artifact.builderReleasePolicy) throw new Error("Instance release binding requires the Workspace Builder and release policy.");
  const binding = JSON.parse(Buffer.from(bindingValue, "base64").toString("utf8")) as VercelReleaseBinding;
  const instanceYaml = builderInstanceYaml();
  if (!instanceYaml) throw new Error("Builder production compilation needs the exact non-secret Instance definition.");
  const state = createPostgresReleasePrivateState();
  const host = new VercelProductionReleaseHost({ binding, state, token: process.env.COMPANYOS_VERCEL_RELEASE_TOKEN ?? "",
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { healthHeaders: { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } } : {}) });
  const execution = new HostedBuilderReleaseAdapter({ artifact, instanceYaml, state, host,
    knowledge: createPostgresKnowledgeProvider(), environment: process.env,
    artifacts: createPostgresWorkflowExecutionStore({ prepareArtifactSchema: false }),
    github: getGitHubRepositoryProvider(), compiler: getTrustedGitExecution() });
  const coordinator = new ReleaseCoordinator({ store: createPostgresReleaseRunStore(), execution,
    leaseMs: 300000, notify: async (run) => integration.notify(run) });
  const integration = createBuilderReleaseIntegration({ ...args, coordinator,
    prepareCandidate: (job) => execution.prepareCandidate(job), fallback: createBuilderChatNotifier(args.chat) });
  return { ...integration, advance: (workerId: string) => coordinator.advance(artifact.instance.id, workerId) };
}
