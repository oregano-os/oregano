import { fork } from "node:child_process";
import type { CompanyToolContext } from "./contracts.ts";

export interface IsolatedToolExecution {
  compiledSource: string;
  file?: string;
  input: unknown;
  context: Omit<CompanyToolContext, "capabilities">;
  allowedCapabilities: readonly string[];
  invokeCapability(capability: string, input: unknown): Promise<unknown>;
  timeoutMs?: number;
}

export async function executeIsolatedCompanyTool(request: IsolatedToolExecution): Promise<unknown> {
  const worker = new URL("./sandbox-worker.mjs", import.meta.url);
  const timeoutMs = request.timeoutMs ?? 5_000;
  return await new Promise((resolve, reject) => {
    const child = fork(worker, [], {
      execArgv: ["--permission", "--experimental-vm-modules", "--max-old-space-size=64"],
      env: { NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
    });
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Company Tool exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      callback();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      if (!settled) finish(() => reject(new Error(`Company Tool sandbox exited with ${code}: ${stderr.trim()}`)));
    });
    child.on("message", async (message: any) => {
      if (message?.type === "capability-call") {
        try {
          if (!request.allowedCapabilities.includes(message.capability)) {
            throw new Error(`Capability '${message.capability}' is not in the resolved Tool contract.`);
          }
          const output = await request.invokeCapability(message.capability, message.input);
          child.send({ type: "capability-result", callId: message.callId, ok: true, output });
        } catch (error) {
          child.send({
            type: "capability-result",
            callId: message.callId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (message?.type === "execution-result") {
        if (message.ok) finish(() => resolve(message.output));
        else finish(() => reject(new Error(message.error)));
      }
    });
    child.send({
      type: "execute",
      compiledSource: request.compiledSource,
      file: request.file,
      input: request.input,
      context: request.context,
      syncTimeoutMs: Math.min(timeoutMs, 1_000),
    });
  });
}
