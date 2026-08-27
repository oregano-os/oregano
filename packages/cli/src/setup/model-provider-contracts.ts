import type { ModelExecutionRoute } from "../../../runner/model-execution.ts";

export type ModelCredentialMode = "platform" | "configure" | "adopt";

export interface SetupModelProviderAdapter {
  readonly route: ModelExecutionRoute;
  readonly executionProvider: string;
  readonly displayName: string;
  readonly allowedCredentialModes: readonly ModelCredentialMode[];
  readonly credentialRef: string | null;
  readonly keyCreationUrl: string | null;
  readonly secretEntrySurface: "none" | "runtime-host-dashboard";
  supports(model: string): boolean;
}

const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Model provider adapter requires ${label}.`);
  return value;
};

export function assertSetupModelProviderAdapter(value: unknown): asserts value is SetupModelProviderAdapter {
  if (!value || typeof value !== "object") throw new Error("Model provider adapter must be an object.");
  const adapter = value as Partial<SetupModelProviderAdapter>;
  requireText(adapter.route, "a route");
  requireText(adapter.executionProvider, "an execution provider");
  requireText(adapter.displayName, "a display name");
  if (!Array.isArray(adapter.allowedCredentialModes) || adapter.allowedCredentialModes.length === 0) {
    throw new Error("Model provider adapter requires at least one credential mode.");
  }
  if (!adapter.allowedCredentialModes.every((mode) => ["platform", "configure", "adopt"].includes(mode))) {
    throw new Error("Model provider adapter declares an unsupported credential mode.");
  }
  if (adapter.secretEntrySurface === "runtime-host-dashboard") {
    requireText(adapter.credentialRef, "a credential reference");
    const keyCreationUrl = requireText(adapter.keyCreationUrl, "a key creation URL");
    if (!keyCreationUrl.startsWith("https://")) throw new Error("Model provider key creation URL must use HTTPS.");
  } else if (adapter.secretEntrySurface !== "none" || adapter.credentialRef !== null || adapter.keyCreationUrl !== null) {
    throw new Error("A credential-free model provider adapter must not declare a credential reference.");
  }
  if (typeof adapter.supports !== "function") throw new Error("Model provider adapter requires supports().");
}

export function defineSetupModelProviderAdapter<const T extends SetupModelProviderAdapter>(adapter: T): Readonly<T> {
  assertSetupModelProviderAdapter(adapter);
  Object.freeze(adapter.allowedCredentialModes);
  return Object.freeze(adapter);
}
