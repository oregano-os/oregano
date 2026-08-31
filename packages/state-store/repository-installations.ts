export type RepositoryInstallationStatus = "active" | "suspended" | "revoked";

export interface RepositoryInstallationBinding {
  readonly bindingId: string;
  readonly instanceId: string;
  readonly providerId: string;
  readonly serviceEnvironment: string;
  readonly installationId: string;
  readonly providerRepositoryId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly status: RepositoryInstallationStatus;
  readonly verifiedAt: string;
  readonly updatedAt: string;
  readonly providerReceipt: Readonly<Record<string, unknown>>;
}

export interface RepositoryInstallationStore {
  putVerified(binding: RepositoryInstallationBinding): Promise<RepositoryInstallationBinding>;
  get(bindingId: string): Promise<RepositoryInstallationBinding | undefined>;
  requireActive(bindingId: string, repositoryId: string): Promise<RepositoryInstallationBinding>;
  updateStatus(args: {
    providerId: string;
    installationId: string;
    status: RepositoryInstallationStatus;
    providerReceipt: Readonly<Record<string, unknown>>;
    updatedAt?: Date;
  }): Promise<number>;
  updateRepositoryStatus(args: {
    providerId: string;
    installationId: string;
    providerRepositoryId: string;
    status: RepositoryInstallationStatus;
    providerReceipt: Readonly<Record<string, unknown>>;
    updatedAt?: Date;
  }): Promise<number>;
}

export function assertRepositoryInstallationBinding(binding: RepositoryInstallationBinding): void {
  for (const [label, value] of [
    ["bindingId", binding.bindingId],
    ["instanceId", binding.instanceId],
    ["providerId", binding.providerId],
    ["serviceEnvironment", binding.serviceEnvironment],
    ["installationId", binding.installationId],
    ["providerRepositoryId", binding.providerRepositoryId],
    ["repositoryId", binding.repositoryId],
    ["owner", binding.owner],
    ["name", binding.name],
    ["defaultBranch", binding.defaultBranch],
  ] as const) {
    if (!value || value.length > 512) throw new Error(`Repository installation ${label} is invalid.`);
  }
  if (!["active", "suspended", "revoked"].includes(binding.status)) {
    throw new Error("Repository installation status is invalid.");
  }
  if (!Number.isFinite(Date.parse(binding.verifiedAt)) || !Number.isFinite(Date.parse(binding.updatedAt))) {
    throw new Error("Repository installation timestamps are invalid.");
  }
  const serialized = JSON.stringify(binding.providerReceipt);
  if (/(private.?key|access.?token|authorization|bearer\s|password|secret)/i.test(serialized)) {
    throw new Error("Repository installation receipt contains credential-like material.");
  }
}
