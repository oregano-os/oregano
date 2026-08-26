import {
  assertRepositoryInstallationBinding,
  type RepositoryInstallationBinding,
  type RepositoryInstallationStore,
  type RepositoryInstallationStatus,
} from "../../state-store/repository-installations.ts";

export class InMemoryRepositoryInstallationStore implements RepositoryInstallationStore {
  readonly #bindings = new Map<string, RepositoryInstallationBinding>();

  async putVerified(binding: RepositoryInstallationBinding): Promise<RepositoryInstallationBinding> {
    assertRepositoryInstallationBinding(binding);
    const existing = this.#bindings.get(binding.bindingId);
    if (existing && (
      existing.instanceId !== binding.instanceId
      || existing.providerId !== binding.providerId
      || existing.serviceEnvironment !== binding.serviceEnvironment
      || existing.installationId !== binding.installationId
      || existing.providerRepositoryId !== binding.providerRepositoryId
      || existing.repositoryId !== binding.repositoryId
    )) {
      throw new Error(`Repository installation binding '${binding.bindingId}' conflicts with verified identity.`);
    }
    this.#bindings.set(binding.bindingId, structuredClone(binding));
    return structuredClone(binding);
  }

  async get(bindingId: string): Promise<RepositoryInstallationBinding | undefined> {
    const binding = this.#bindings.get(bindingId);
    return binding ? structuredClone(binding) : undefined;
  }

  async requireActive(bindingId: string, repositoryId: string): Promise<RepositoryInstallationBinding> {
    const binding = this.#bindings.get(bindingId);
    if (!binding || binding.repositoryId !== repositoryId || binding.status !== "active") {
      throw new Error(`Repository installation binding '${bindingId}' is unavailable, inactive, or unauthorized.`);
    }
    return structuredClone(binding);
  }

  async updateStatus(args: {
    providerId: string;
    installationId: string;
    status: RepositoryInstallationStatus;
    providerReceipt: Readonly<Record<string, unknown>>;
    updatedAt?: Date;
  }): Promise<number> {
    let changed = 0;
    for (const [bindingId, binding] of this.#bindings) {
      if (binding.providerId !== args.providerId || binding.installationId !== args.installationId) continue;
      const updated = {
        ...binding,
        status: args.status,
        providerReceipt: structuredClone(args.providerReceipt),
        updatedAt: (args.updatedAt ?? new Date()).toISOString(),
      };
      assertRepositoryInstallationBinding(updated);
      this.#bindings.set(bindingId, updated);
      changed += 1;
    }
    return changed;
  }

  async updateRepositoryStatus(args: {
    providerId: string;
    installationId: string;
    providerRepositoryId: string;
    status: RepositoryInstallationStatus;
    providerReceipt: Readonly<Record<string, unknown>>;
    updatedAt?: Date;
  }): Promise<number> {
    let changed = 0;
    for (const [bindingId, binding] of this.#bindings) {
      if (
        binding.providerId !== args.providerId
        || binding.installationId !== args.installationId
        || binding.providerRepositoryId !== args.providerRepositoryId
      ) continue;
      const updated = {
        ...binding,
        status: args.status,
        providerReceipt: structuredClone(args.providerReceipt),
        updatedAt: (args.updatedAt ?? new Date()).toISOString(),
      };
      assertRepositoryInstallationBinding(updated);
      this.#bindings.set(bindingId, updated);
      changed += 1;
    }
    return changed;
  }
}
