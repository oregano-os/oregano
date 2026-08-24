export type SetupProviderRole =
  | "source-host"
  | "runtime-host"
  | "state-service"
  | "communication";

export interface SetupProviderAdapter {
  readonly role: SetupProviderRole;
  readonly provider: string;
}

export interface ProviderResourceReceipt {
  readonly id: string;
  readonly uid: string;
  readonly name: string;
}

export interface RuntimeProjectConfiguration {
  readonly rootDirectory: string;
  readonly framework: string;
  readonly sourceFilesOutsideRootDirectory: boolean;
}

export interface SourceHostAdapter extends SetupProviderAdapter {
  readonly role: "source-host";
  readonly privateRepositoryRequired: true;
  repositoryReference(owner: string, repository: string): string;
}

export interface RuntimeHostAdapter extends SetupProviderAdapter {
  readonly role: "runtime-host";
  readonly cliVersion: string;
  readonly projectRoot: string;
  readonly framework: string;
  readonly sourceFilesOutsideRootDirectory: boolean;
  readonly environmentConflictPolicy: "refuse";
  projectEndpoint(project: string): string;
  expectedProjectConfiguration(): RuntimeProjectConfiguration;
}

export interface StateServiceAdapter extends SetupProviderAdapter {
  readonly role: "state-service";
  readonly qualifiedPlan: string;
  readonly qualifiedRegion: string;
  normalizeCreateReceipt(payload: unknown, expectedName: string): ProviderResourceReceipt;
}

export interface CommunicationAdapter extends SetupProviderAdapter {
  readonly role: "communication";
  readonly connectorService: string;
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly triggerPath: string;
  readonly userAuthorizationScopes: readonly string[];
  expectedConnectorUid(): string;
  normalizeCreateReceipt(payload: unknown): ProviderResourceReceipt;
  userAuthorizationArguments(connector: string): readonly string[];
  triggerAttachmentArguments(connector: string, project: string): readonly string[];
}

export interface SetupProviderProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceHost: SourceHostAdapter;
  readonly runtimeHost: RuntimeHostAdapter;
  readonly stateService: StateServiceAdapter;
  readonly communication: CommunicationAdapter;
}

const REQUIRED_ROLES: ReadonlyArray<readonly [keyof SetupProviderProfile, SetupProviderRole]> = [
  ["sourceHost", "source-host"],
  ["runtimeHost", "runtime-host"],
  ["stateService", "state-service"],
  ["communication", "communication"],
];

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Setup provider profile requires ${label}.`);
  }
  return value;
};

export function assertSetupProviderProfile(value: unknown): asserts value is SetupProviderProfile {
  if (!value || typeof value !== "object") throw new Error("Setup provider profile must be an object.");
  const profile = value as Partial<SetupProviderProfile>;
  if (profile.schemaVersion !== 1) throw new Error("Unsupported setup provider profile schema.");
  requireText(profile.id, "an id");
  for (const [key, role] of REQUIRED_ROLES) {
    const adapter = profile[key] as SetupProviderAdapter | undefined;
    if (!adapter || adapter.role !== role) throw new Error(`Setup provider profile requires the '${role}' adapter.`);
    requireText(adapter.provider, `a provider for '${role}'`);
  }
  requireText(profile.runtimeHost?.projectRoot, "a runtime project root");
  requireText(profile.runtimeHost?.cliVersion, "a runtime provider CLI version");
  requireText(profile.runtimeHost?.framework, "a runtime framework");
  if (profile.runtimeHost?.environmentConflictPolicy !== "refuse") {
    throw new Error("Setup provider profiles must refuse environment-variable conflicts.");
  }
  requireText(profile.stateService?.qualifiedPlan, "a qualified state-service plan");
  requireText(profile.stateService?.qualifiedRegion, "a qualified state-service region");
  requireText(profile.communication?.agentId, "an internal agent id");
  requireText(profile.communication?.agentDisplayName, "an agent display name");
  requireText(profile.communication?.triggerPath, "a communication trigger path");
  if (!profile.communication?.triggerPath.startsWith("/")) {
    throw new Error("Communication trigger path must be absolute.");
  }
  if (!Array.isArray(profile.communication?.userAuthorizationScopes) || profile.communication.userAuthorizationScopes.length === 0) {
    throw new Error("Communication adapter requires least-privilege user authorization scopes.");
  }
  for (const [method, candidate] of [
    ["sourceHost.repositoryReference", profile.sourceHost?.repositoryReference],
    ["runtimeHost.projectEndpoint", profile.runtimeHost?.projectEndpoint],
    ["runtimeHost.expectedProjectConfiguration", profile.runtimeHost?.expectedProjectConfiguration],
    ["stateService.normalizeCreateReceipt", profile.stateService?.normalizeCreateReceipt],
    ["communication.expectedConnectorUid", profile.communication?.expectedConnectorUid],
    ["communication.normalizeCreateReceipt", profile.communication?.normalizeCreateReceipt],
    ["communication.userAuthorizationArguments", profile.communication?.userAuthorizationArguments],
    ["communication.triggerAttachmentArguments", profile.communication?.triggerAttachmentArguments],
  ] as const) {
    if (typeof candidate !== "function") throw new Error(`Setup provider profile requires ${method}().`);
  }
}

export function defineSetupProviderProfile<const T extends SetupProviderProfile>(profile: T): Readonly<T> {
  assertSetupProviderProfile(profile);
  Object.freeze(profile.sourceHost);
  Object.freeze(profile.runtimeHost);
  Object.freeze(profile.stateService);
  Object.freeze(profile.communication.userAuthorizationScopes);
  Object.freeze(profile.communication);
  return Object.freeze(profile);
}
