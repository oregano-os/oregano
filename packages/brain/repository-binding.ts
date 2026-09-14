import { BrainError } from "./contracts.ts";
import type { BrainRepositoryBinding } from "../runtime/repository/contracts.ts";

export function assertBrainRepositoryBinding(value: BrainRepositoryBinding): void {
  if (!value || ["instanceId", "bindingId", "repositoryId", "branch"].some(key => {
    const item = value[key as keyof BrainRepositoryBinding];
    return typeof item !== "string" || !item || item.length > 256;
  }) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repositoryId)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) || value.branch.includes("..")
    || value.branch.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) {
    throw new BrainError("invalid_binding", "Brain requires an explicit Instance, existing installation binding, repository identity and safe branch.");
  }
}

/** Non-secret Instance configuration. Enabling this connector grants no Agent access. */
export function parseBrainRepositoryBinding(configuration: Record<string, unknown>, instanceId: string): BrainRepositoryBinding {
  const keys = ["repository_binding_id", "repository_id", "branch"];
  if (!configuration || Object.keys(configuration).some(key => !keys.includes(key))) throw new BrainError("invalid_binding", "Unsupported Brain connector configuration field.");
  const value = { instanceId, bindingId: configuration.repository_binding_id, repositoryId: configuration.repository_id, branch: configuration.branch } as BrainRepositoryBinding;
  assertBrainRepositoryBinding(value);
  return value;
}
