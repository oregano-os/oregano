import { defineSetupProviderProfile } from "../provider-contracts.ts";
import type { ProviderResourceReceipt } from "../provider-contracts.ts";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const unwrapReceipt = (payload: unknown, wrappers: readonly string[]): unknown => {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  for (const wrapper of wrappers) {
    const candidate = record[wrapper];
    if (Array.isArray(candidate) && candidate.length > 0) return candidate[0];
    if (candidate && typeof candidate === "object") return candidate;
  }
  return payload;
};

const resourceReceipt = (payload: unknown, expectedName = ""): ProviderResourceReceipt => {
  const candidate = unwrapReceipt(payload, ["resource", "connector", "resources", "connectors", "data"]);
  const record = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  return {
    id: text(record.id ?? record.resourceId ?? record.uid),
    uid: text(record.uid ?? record.slug ?? record.id),
    name: text(record.name ?? record.displayName ?? record.uid ?? record.slug) || expectedName,
  };
};

export const VERCEL_NEON_SLACK_PROFILE = defineSetupProviderProfile({
  schemaVersion: 1,
  id: "vercel-neon-slack",
  sourceHost: {
    role: "source-host",
    provider: "github",
    privateRepositoryRequired: true,
    repositoryReference(owner, repository) {
      return `${owner}/${repository}`;
    },
  },
  runtimeHost: {
    role: "runtime-host",
    provider: "vercel",
    cliVersion: "56.3.2",
    projectRoot: "packages/runner-vercel",
    framework: "nextjs",
    sourceFilesOutsideRootDirectory: true,
    environmentConflictPolicy: "refuse",
    projectEndpoint(project) {
      return `/v9/projects/${encodeURIComponent(project)}`;
    },
    expectedProjectConfiguration() {
      return {
        rootDirectory: this.projectRoot,
        framework: this.framework,
        sourceFilesOutsideRootDirectory: this.sourceFilesOutsideRootDirectory,
      };
    },
  },
  stateService: {
    role: "state-service",
    provider: "neon",
    qualifiedPlan: "free_v3",
    qualifiedRegion: "fra1",
    normalizeCreateReceipt(payload, expectedName) {
      return resourceReceipt(payload, expectedName);
    },
  },
  communication: {
    role: "communication",
    provider: "slack",
    connectorService: "slack",
    agentId: "oregano",
    agentDisplayName: "oregano",
    triggerPath: "/api/webhooks/slack",
    userAuthorizationScopes: ["identity.basic"],
    expectedConnectorUid() {
      return `${this.connectorService}/${this.agentDisplayName}`;
    },
    normalizeCreateReceipt(payload) {
      return resourceReceipt(payload, this.agentDisplayName);
    },
    userAuthorizationArguments(connector) {
      return ["connect", "token", connector, "--subject", "user", "--scopes", this.userAuthorizationScopes.join(","), "--format", "json", "--yes"];
    },
    triggerAttachmentArguments(connector, project) {
      return ["connect", "attach", connector, "--project", project, "--environment", "production", "--triggers", "--trigger-path", this.triggerPath, "--yes", "--format", "json"];
    },
  },
});
