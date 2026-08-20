import vm from "node:vm";

const pending = new Map();
let sequence = 0;

const capabilityCall = (capability, input) => new Promise((resolve, reject) => {
  sequence += 1;
  const callId = `cap_${sequence}`;
  pending.set(callId, { resolve, reject });
  process.send({ type: "capability-call", callId, capability, input });
});

process.on("message", async (message) => {
  if (message?.type === "capability-result") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.ok) entry.resolve(message.output);
    else entry.reject(new Error(message.error));
    return;
  }
  if (message?.type !== "execute") return;
  try {
    const defineCompanyTool = (definition) => Object.freeze(definition);
    const sandbox = {};
    const context = vm.createContext(sandbox, {
      name: "companyos-company-tool",
      codeGeneration: { strings: false, wasm: false },
    });
    const toolModule = new vm.SourceTextModule(message.compiledSource, {
      context,
      identifier: message.file ?? "execute.js",
    });
    await toolModule.link(async (specifier) => {
      if (specifier !== "@companyos/tool-sdk") throw new Error(`Forbidden runtime import '${specifier}'.`);
      return new vm.SyntheticModule(["defineCompanyTool"], function initialize() {
        this.setExport("defineCompanyTool", defineCompanyTool);
      }, { context, identifier: "@companyos/tool-sdk" });
    });
    await toolModule.evaluate({ timeout: message.syncTimeoutMs });
    const definition = toolModule.namespace.default;
    if (!definition || typeof definition.execute !== "function") throw new Error("Company Tool did not export an executable definition.");
    const toolContext = Object.freeze({
      ...message.context,
      capabilities: Object.freeze({ call: capabilityCall }),
    });
    const result = await definition.execute(structuredClone(message.input), toolContext);
    process.send({ type: "execution-result", ok: true, output: result });
  } catch (error) {
    process.send({ type: "execution-result", ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
