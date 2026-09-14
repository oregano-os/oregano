import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compileBrainAdoption, compileWorkspaceRuntimePolicy } from "../../companyos-builder/brain-adoption.ts";
import { checkBrainCorpus } from "../../brain/documents.ts";
import { readLocalBrainFilesSync } from "../../brain/local-files.ts";
import { sha256 } from "../../runtime/canonical.ts";

/** Local validation never opens a database connection or changes repository files. */
export function checkBrainWorkspace(root, { requireAdoption = false } = {}) {
  const declarations = {};
  for (const path of [".companyos/governance.yaml", ".companyos/brain.yaml"]) if (existsSync(join(root, path))) declarations[path] = readFileSync(join(root, path), "utf8");
  try {
    const adoption = compileBrainAdoption(declarations, compileWorkspaceRuntimePolicy(declarations));
    const files = readLocalBrainFilesSync(root);
    if (!adoption) {
      if (requireAdoption || Object.keys(files).length) throw new Error("Brain knowledge requires explicit Workspace adoption.");
      return { ok: true, enabled: false, pages: 0, diagnostics: [] };
    }
    const checked = checkBrainCorpus(files, adoption.configuration);
    return { ok: !checked.diagnostics.some(item => item.severity === "error"), enabled: true, pages: checked.pages.length, diagnostics: checked.diagnostics };
  } catch (error) { return { ok: false, pages: 0, diagnostics: [{ code: "BRAIN001", severity: "error", message: error.message }] }; }
}

/** Privileged operator input, produced by companyos build; never a public auth endpoint. */
export function loadBrainOperatorArtifact(path, coreCommit) {
  if (!path || statSync(path).size > 10_000_000) throw new Error("Brain operator commands require a bounded --artifact file from companyos build.");
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const { artifactHash, ...withoutHash } = artifact;
  if (artifact.schemaVersion !== 1 || artifactHash !== sha256({ ...withoutHash, provenance: { ...withoutHash.provenance, builtAt: undefined } })) throw new Error("Brain Artifact integrity check failed.");
  if (artifact.provenance.coreCommit !== coreCommit) throw new Error("Run Brain commands from the exact Core commit recorded by the Artifact.");
  const entries = artifact.connectors?.filter(entry => entry.connector === "oregano/brain") ?? [];
  if (entries.length !== 1 || !artifact.brain) throw new Error("Brain operator commands require one adopted, explicitly bound Brain connector.");
  return { artifact, entry: entries[0] };
}

export async function runBrainOperatorCommand({ action, artifact, entry, agentId, subjectPrincipal, input }) {
  const { syncRuntimeBrain, createRuntimeBrainConnector } = await import("../../runner-vercel/src/lib/brain.ts");
  if (action === "sync") return syncRuntimeBrain(artifact, entry);
  if (!["recall", "entity", "context_pack", "synthesize"].includes(action)) throw new Error("Unsupported Brain operator command.");
  if (!agentId || !subjectPrincipal) throw new Error("Brain reads require --agent and --subject-principal from the existing active roster. This local operator command is not an authentication surface.");
  const { CompanyOSRuntime } = await import("../../runtime/companyos-runtime.ts");
  const { createPostgresStateStore } = await import("../../state-postgres/store.ts");
  const { qualifyCompanyDatabase } = await import("../../state-postgres/database-bootstrap.ts");
  await qualifyCompanyDatabase();
  const runtime = new CompanyOSRuntime({ artifact, state: createPostgresStateStore(),
    // Standalone operator reads have no active Workflow assignment, matching
    // the normal conversation host. Reserved Workflow Tools still fail closed.
    workflowContext: { read: async () => undefined },
    connectors: [createRuntimeBrainConnector(artifact, entry)] });
  return runtime.execute({ runId: `brain-operator-${randomUUID()}`, stepId: action, agentId, grantId: `oregano:brain/${action}`, subjectPrincipal, input });
}
