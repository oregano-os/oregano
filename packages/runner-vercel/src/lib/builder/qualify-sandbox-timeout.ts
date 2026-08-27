import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { VercelSandboxBuilderExecutionAdapter } from "./sandbox-execution-adapter.ts";

const adapter = new VercelSandboxBuilderExecutionAdapter();
const handle = await adapter.start({
  schemaVersion: 1,
  jobId: `timeout-qualification-${randomUUID()}`,
  source: {
    repository: "https://example.invalid/company-workspace.git",
    baseCommit: "c".repeat(40),
  },
  codingAgent: {
    profileId: "codex",
    implementation: "@agentclientprotocol/codex-acp",
    version: "1.6.2",
  },
  limits: { timeoutMs: 10_000 },
  networkPolicyId: "deny-all-timeout-qualification",
});

const pollStartedAt = Date.now();
try {
  let status = await adapter.status(handle);
  while ((status.state === "starting" || status.state === "running") && Date.now() - pollStartedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    status = await adapter.status(handle);
  }
  if (status.state !== "timed_out") {
    const sandbox = await Sandbox.get({ name: handle.executionId });
    const session = sandbox.currentSession();
    const providerEvidence = {
      sandboxStatus: sandbox.status,
      expiresAt: sandbox.expiresAt?.toISOString(),
      statusUpdatedAt: sandbox.statusUpdatedAt?.toISOString(),
      requestedAt: session.requestedAt.toISOString(),
      startedAt: session.startedAt?.toISOString(),
      requestedStopAt: session.requestedStopAt?.toISOString(),
      stoppedAt: session.stoppedAt?.toISOString(),
      abortedAt: session.abortedAt?.toISOString(),
    };
    throw new Error(
      `Vercel Sandbox timeout qualification ended in '${status.state}': ${JSON.stringify(providerEvidence)}`,
    );
  }
  const result = await adapter.collect(handle);
  process.stdout.write(`${JSON.stringify({
    status,
    result,
    observedAfterMs: Date.now() - pollStartedAt,
  }, null, 2)}\n`);
} finally {
  await adapter.dispose(handle).catch(() => undefined);
}
