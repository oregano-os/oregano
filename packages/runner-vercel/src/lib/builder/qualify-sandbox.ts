import { randomUUID } from "node:crypto";
import { VercelSandboxBuilderExecutionAdapter } from "./sandbox-execution-adapter.ts";

const adapter = new VercelSandboxBuilderExecutionAdapter();
const request = {
  schemaVersion: 1,
  jobId: `qualification-${randomUUID()}`,
  source: {
    repository: "https://example.invalid/company-workspace.git",
    baseCommit: "b".repeat(40),
  },
  codingAgent: {
    profileId: "codex",
    implementation: "@agentclientprotocol/codex-acp",
    version: "1.6.2",
  },
  limits: { timeoutMs: 120_000 },
  networkPolicyId: "deny-all-qualification",
} as const;
let handle: Awaited<ReturnType<typeof adapter.start>> | undefined;

try {
  const starts = await Promise.allSettled([
    adapter.start(request),
    adapter.start(request),
  ]);
  handle = starts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.start>>> => (
    result.status === "fulfilled"
  ))?.value;
  const failed = starts.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (!handle) throw failed?.reason ?? new Error("Vercel Sandbox start did not return a handle.");
  if (failed) throw failed.reason;
  const duplicateHandle = starts[1].status === "fulfilled" ? starts[1].value : undefined;
  if (!duplicateHandle || duplicateHandle.executionId !== handle.executionId) {
    throw new Error("Duplicate Builder delivery created more than one Vercel Sandbox.");
  }
  const status = await adapter.status(handle);
  const qualification = await adapter.qualificationProbe(handle);
  const replacementCoordinator = new VercelSandboxBuilderExecutionAdapter();
  const recovery = await replacementCoordinator.qualificationRecoveryProbe(handle);
  await replacementCoordinator.cancel(handle);
  const result = await replacementCoordinator.collect(handle);
  await replacementCoordinator.dispose(handle);
  process.stdout.write(`${JSON.stringify({
    duplicateDeliveryIdempotent: true,
    status,
    qualification,
    recovery,
    result,
  }, null, 2)}\n`);
} finally {
  if (handle) await adapter.dispose(handle).catch(() => undefined);
}
