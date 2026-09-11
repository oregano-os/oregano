import { sha256 } from "../runtime/canonical.ts";

// Trusted, non-secret Instance settings that may exist only on a deployment.
// Provider credentials remain project-managed; never copy the full process env.
const keys = [
  "COMPANYOS_BUILDER_RELEASE_BINDING_BASE64",
  "COMPANYOS_BUILDER_SNAPSHOT_ID",
  "COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID",
  "COMPANYOS_BUILDER_TRUSTED_GIT_SNAPSHOT_ID",
  "COMPANYOS_WORKFLOW_ENABLED",
] as const;
export function releaseContinuityEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(keys.filter(key => environment[key] !== undefined).map(key => [key, environment[key]!]));
}
export function releaseContinuityDigest(environment: Readonly<Record<string, string | undefined>>): string {
  return sha256(releaseContinuityEnvironment(environment));
}
