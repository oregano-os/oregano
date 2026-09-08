import { gzipSync } from "node:zlib";
import type { CompanyOSArtifact } from "../../../../companyos-builder/types.ts";
import { decodeCompanyRecordsProductionConfiguration, assertCompanyRecordsProductionIdentity } from "../company-records-production.ts";
import { decodeWorkflowHostingConfiguration, workflowHostingEnabled } from "../workflow-configuration.ts";

const encoded = (value: unknown) => gzipSync(JSON.stringify(value)).toString("base64");

/** Carry reviewed bindings forward; never discover resources or copy secrets. */
export function rebindBuilderReleaseEnvironment(args: {
  previous: CompanyOSArtifact; next: CompanyOSArtifact; changedPaths: readonly string[];
  environment: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { previous, next, environment, changedPaths } = args;
  if (previous.instance.id !== next.instance.id || previous.instance.environment !== "production"
    || next.instance.environment !== "production" || previous.provenance.coreCommit !== next.provenance.coreCommit) throw new Error("Workspace release cannot change the production Instance or Core.");
  const overrides: Record<string, string> = {};
  if (environment.COMPANYOS_RECORDS_CONFIG_GZIP_BASE64) {
    // Binding or roster changes need a fresh connector/identity qualification;
    // an unrelated Workspace edit must still advance the exact source pairing.
    if (changedPaths.some((path) => path.startsWith("records/") || path.startsWith("connections/") || /(?:^|\/)roster\.md$/.test(path))) throw new Error("Changed record sources or identities require renewed Instance qualification before live adoption.");
    const configuration = decodeCompanyRecordsProductionConfiguration(environment.COMPANYOS_RECORDS_CONFIG_GZIP_BASE64);
    assertCompanyRecordsProductionIdentity(configuration, environment, { instance_id: previous.instance.id,
      core_ref: previous.provenance.coreCommit, workspace_ref: previous.provenance.workspaceCommit });
    overrides.COMPANYOS_RECORDS_CONFIG_GZIP_BASE64 = encoded({ ...configuration, workspace: { ...configuration.workspace, ref: next.provenance.workspaceCommit } });
  }
  if (workflowHostingEnabled(environment)) {
    const configuration = decodeWorkflowHostingConfiguration(previous, environment);
    const value = encoded({ ...configuration, artifactHash: next.artifactHash });
    // Revalidate the retained enabled IDs, operators and schedules against the
    // new Workspace. A Workspace cannot activate additional hosted workflows.
    decodeWorkflowHostingConfiguration(next, { ...environment, COMPANYOS_WORKFLOW_CONFIG_GZIP_BASE64: value });
    overrides.COMPANYOS_WORKFLOW_CONFIG_GZIP_BASE64 = value;
  }
  return overrides;
}
