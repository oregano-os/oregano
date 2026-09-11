import { releaseContinuityEnvironment, releaseContinuityDigest } from "./release-continuity.ts";
import { sha256 } from "../runtime/canonical.ts";
import type { DeploymentReceipt, ProductionArtifactReceipt, ProductionVerification } from "../runtime/release/contracts.ts";

export interface ReleasePrivateState {
  get<T>(key: string): Promise<T | null | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  setIfNotExists(key: string, value: unknown): Promise<boolean>;
}
export interface VercelReleaseBinding {
  projectId: string; teamId: string; productionUrl: string;
}
interface Deployment {
  id: string; projectId: string; name: string; target: string; readyState: string; url: string;
  meta?: Record<string, string>;
}
interface Project { id: string; name: string; targets?: { production?: { id: string } }; }
interface StagingIntent { fingerprint: string; deploymentId?: string; startedAt: string; }
class VercelReleaseApiError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Vercel release request failed (${status}).`); this.status = status; }
}

/** Trusted Vercel API boundary; API credentials never enter the coding sandbox. */
export class VercelProductionReleaseHost {
  private readonly dependencies: {
    binding: VercelReleaseBinding; token: string; state: ReleasePrivateState;
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch; healthHeaders?: Record<string, string>;
  };
  constructor(dependencies: VercelProductionReleaseHost["dependencies"]) {
    this.dependencies = dependencies;
    const { binding, token } = dependencies;
    const url = new URL(binding.productionUrl);
    if (!binding.projectId.startsWith("prj_") || !binding.teamId.startsWith("team_") || !token
      || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Vercel release requires an exact project, team, production origin and service credential.");
  }
  async #api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", this.dependencies.binding.teamId);
    const response = await (this.dependencies.fetch ?? fetch)(url, { method, redirect: "error",
      signal: AbortSignal.timeout(25000), headers: { authorization: `Bearer ${this.dependencies.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new VercelReleaseApiError(response.status);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async current(): Promise<{ deployment: Deployment; health: ProductionVerification }> {
    const { projectId, productionUrl } = this.dependencies.binding;
    const project = await this.#api<Project>("GET", `/v9/projects/${projectId}`);
    const id = project.targets?.production?.id;
    if (project.id !== projectId || !id) throw new Error("Vercel has no current production deployment for the bound project.");
    const deployment = await this.#api<Deployment>("GET", `/v13/deployments/${id}`);
    if (deployment.id !== id || deployment.projectId !== projectId || deployment.target !== "production" || deployment.readyState !== "READY") throw new Error("Vercel production deployment is not ready.");
    const response = await (this.dependencies.fetch ?? fetch)(new URL("/api/health", productionUrl), {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000), headers: this.dependencies.healthHeaders });
    if (!response.ok) throw new Error("Production health is unavailable.");
    const health = await response.json() as Record<string, any>;
    const latest = await this.#api<Project>("GET", `/v9/projects/${projectId}`);
    if (latest.targets?.production?.id !== id || !health.ok || health.status !== "ready" || health.deploymentId !== id
      || health.instance?.environment !== "production" || health.sourceCoreCommit !== health.coreCommit
      || !/^[a-f0-9]{40}$/.test(health.coreCommit ?? "") || !/^[a-f0-9]{64}$/.test(health.configurationDigest ?? "")) throw new Error("Production health does not prove the current deployment and configuration.");
    this.#assertContinuity(health);
    return { deployment, health: { deploymentId: id, ready: true, environment: "production", instanceId: health.instance.id,
      artifactHash: health.artifactHash, coreCommit: health.coreCommit, workspaceCommit: health.workspaceCommit, configurationDigest: health.configurationDigest } };
  }

  /** Creates a production-target build without assigning live domains. */
  async stage(args: { operationId: string; previous: DeploymentReceipt; artifact: ProductionArtifactReceipt; encodedArtifact: string; retainedArtifactHash?: string; environmentOverrides?: Record<string, string> }): Promise<Deployment | undefined> {
    const { projectId } = this.dependencies.binding;
    const key = `release:vercel:stage:${sha256([projectId, args.operationId])}`;
    const operation = sha256(args.operationId);
    const overrides = args.environmentOverrides ?? {};
    if (Object.keys(overrides).some((key) => !["COMPANYOS_RECORDS_CONFIG_GZIP_BASE64", "COMPANYOS_WORKFLOW_CONFIG_GZIP_BASE64"].includes(key))) throw new Error("Release may only rebind maintained non-secret production configurations.");
    if (args.retainedArtifactHash !== undefined && args.retainedArtifactHash !== args.artifact.artifactHash) throw new Error("Retained Artifact reference differs from the checked release.");
    const continuity = releaseContinuityEnvironment(this.dependencies.environment ?? {});
    const environment = args.retainedArtifactHash
      ? { ...continuity, ...overrides, COMPANYOS_ARTIFACT_HASH: args.retainedArtifactHash, COMPANYOS_ARTIFACT_GZIP_BASE64: "" }
      : { ...continuity, ...overrides, COMPANYOS_ARTIFACT_HASH: "", COMPANYOS_ARTIFACT_GZIP_BASE64: args.encodedArtifact };
    const fingerprint = sha256({ previous: args.previous, artifact: args.artifact, environment });
    let intent = await this.dependencies.state.get<StagingIntent>(key);
    // Read-only failures must not reserve an operation that never reached the
    // provider. Once reserved, ambiguous creates are only reconciled.
    let current: Awaited<ReturnType<VercelProductionReleaseHost["current"]>> | undefined;
    if (!intent) {
      current = await this.current();
      if (current.health.deploymentId !== args.previous.deploymentId || current.health.artifactHash !== args.previous.artifactHash
        || current.health.coreCommit !== args.artifact.coreCommit || current.health.configurationDigest !== args.artifact.configurationDigest) throw new Error("Production pairing changed before staging.");
    }
    const winner = !intent && await this.dependencies.state.setIfNotExists(key, { fingerprint, startedAt: new Date().toISOString() } satisfies StagingIntent);
    intent = await this.dependencies.state.get<StagingIntent>(key);
    if (!intent || intent.fingerprint !== fingerprint) throw new Error("Vercel staging operation was reused with different content.");
    if (!intent.deploymentId) {
      const found = await this.#api<{ deployments: Array<Deployment & { uid?: string }> }>("GET", `/v6/deployments?projectId=${projectId}&meta-companyosReleaseOperation=${operation}&limit=100`);
      const matches = found.deployments.filter((d) => d.meta?.companyosReleaseOperation === operation);
      if (matches.length > 1) throw new Error("Ambiguous Vercel staging receipts require operator reconciliation.");
      let id = matches[0]?.id ?? matches[0]?.uid;
      if (!id && winner) {
        try {
          const created = await this.#api<Deployment>("POST", "/v13/deployments", {
            name: current!.deployment.name, project: projectId, deploymentId: args.previous.deploymentId,
            withLatestCommit: false, target: "production", autoAssignCustomDomains: false,
            env: environment,
            build: { env: environment },
            meta: { companyosReleaseOperation: operation, companyosArtifactHash: args.artifact.artifactHash,
              companyosCoreCommit: args.artifact.coreCommit, companyosWorkspaceCommit: args.artifact.workspaceCommit,
              companyosConfigurationDigest: args.artifact.configurationDigest },
          });
          id = created.id;
        } catch (error) {
          if (error instanceof VercelReleaseApiError && [400, 401, 403, 404, 422].includes(error.status)) throw error;
          // Keep the durable intent. The next call searches provider receipts;
          // it must never issue a second create after an ambiguous result.
          return undefined;
        }
      }
      if (!id) return undefined;
      intent = { ...intent, deploymentId: id };
      await this.dependencies.state.set(key, intent);
    }
    const deployment = await this.#api<Deployment>("GET", `/v13/deployments/${intent.deploymentId}`);
    this.#assertStaged(deployment, args.artifact, operation);
    if (["ERROR", "CANCELED"].includes(deployment.readyState)) throw new Error("Production build failed.");
    return deployment.readyState === "READY" ? deployment : undefined;
  }
  #assertStaged(deployment: Deployment, artifact: ProductionArtifactReceipt, operation: string) {
    if (deployment.projectId !== this.dependencies.binding.projectId || deployment.target !== "production"
      || deployment.meta?.companyosReleaseOperation !== operation || deployment.meta?.companyosArtifactHash !== artifact.artifactHash
      || deployment.meta?.companyosCoreCommit !== artifact.coreCommit || deployment.meta?.companyosWorkspaceCommit !== artifact.workspaceCommit
      || deployment.meta?.companyosConfigurationDigest !== artifact.configurationDigest) throw new Error("Staged deployment differs from the accepted production artifact.");
  }
  #assertContinuity(health: Record<string, any>) {
    if (health.releaseContinuityDigest !== releaseContinuityDigest(this.dependencies.environment ?? {})
      || health.builder?.releaseConfigured !== true || health.builder?.codingConfigured !== true
      || !health.knowledgeSnapshotHash) throw new Error("The deployment lost required Builder runtime configuration.");
  }
  async promote(args: { deploymentId: string; artifact: ProductionArtifactReceipt; previousArtifactHash: string }): Promise<DeploymentReceipt | undefined> {
    const { projectId } = this.dependencies.binding;
    const current = await this.current();
    if (current.health.deploymentId === args.deploymentId && current.health.artifactHash === args.artifact.artifactHash) return { ...args.artifact, deploymentId: args.deploymentId };
    if (current.health.artifactHash !== args.previousArtifactHash) throw new Error("A different production version became active before promotion.");
    const deployment = await this.#api<Deployment>("GET", `/v13/deployments/${args.deploymentId}`);
    if (deployment.readyState !== "READY" || deployment.projectId !== projectId || deployment.target !== "production"
      || deployment.meta?.companyosArtifactHash !== args.artifact.artifactHash) throw new Error("Only the completed production build may be promoted.");
    if (!/^[a-z0-9.-]+\.vercel\.app$/.test(deployment.url)) throw new Error("Staged health requires a Vercel deployment origin.");
    const response = await (this.dependencies.fetch ?? fetch)(`https://${deployment.url}/api/health`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000), headers: this.dependencies.healthHeaders });
    if (!response.ok) throw new Error("The staged production build did not pass health verification.");
    const health = await response.json() as Record<string, any>;
    if (!health.ok || health.status !== "ready" || health.deploymentId !== args.deploymentId
      || health.artifactHash !== args.artifact.artifactHash || health.instance?.id !== args.artifact.instanceId
      || health.instance?.environment !== "production" || health.coreCommit !== args.artifact.coreCommit || health.sourceCoreCommit !== health.coreCommit
      || health.workspaceCommit !== args.artifact.workspaceCommit || health.configurationDigest !== args.artifact.configurationDigest) throw new Error("The staged build does not run the exact accepted production pairing.");
    this.#assertContinuity(health);
    try { await this.#api("POST", `/v10/projects/${projectId}/promote/${args.deploymentId}`); }
    catch (error) {
      if (error instanceof VercelReleaseApiError && [400, 401, 403, 404, 422].includes(error.status)) throw error;
      return undefined;
    }
    // Promotion is asynchronous; a future poll verifies the actual live alias.
    return undefined;
  }
}
