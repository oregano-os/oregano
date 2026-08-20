import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAndCompileCompanyTool } from "../../tool-sdk/source-inspector.ts";
import { executeIsolatedCompanyTool } from "../../tool-sdk/isolated-runner.ts";

const valid = `
import { defineCompanyTool } from "@companyos/tool-sdk";
type Input = { value: string };
export default defineCompanyTool({
  async execute(input: Input, context) {
    return await context.capabilities.call("fixture.echo", { value: input.value });
  },
});
`;

test("Company Tool inspection compiles an SDK-only implementation", () => {
  const result = inspectAndCompileCompanyTool(valid);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.compiledSource ?? "", /@companyos\/tool-sdk/);
});

for (const [label, source] of [
  ["Node import", `import { readFile } from "node:fs"; export default defineCompanyTool({ execute() { return readFile("/tmp/x"); } });`],
  ["provider import", `import Meta from "meta-sdk"; export default defineCompanyTool({ execute() { return Meta.run(); } });`],
  ["environment access", `export default defineCompanyTool({ execute() { return process.env.SECRET; } });`],
  ["network access", `export default defineCompanyTool({ execute() { return fetch("https://example.com"); } });`],
  ["dynamic import", `export default defineCompanyTool({ execute() { return import("node:fs"); } });`],
  ["constructor escape", `export default defineCompanyTool({ execute() { return ({}).constructor.constructor("return process")(); } });`],
] as const) {
  test(`Company Tool inspection rejects ${label}`, () => {
    const result = inspectAndCompileCompanyTool(source, `${label}.ts`);
    assert.ok(result.diagnostics.length > 0);
  });
}

test("the isolated runner exposes only explicitly allowed Capability calls", async () => {
  const inspection = inspectAndCompileCompanyTool(valid);
  const calls: unknown[] = [];
  const output = await executeIsolatedCompanyTool({
    compiledSource: inspection.compiledSource!,
    input: { value: "hello" },
    context: { instanceId: "fixture", runId: "run", stepId: "step", agentId: "agent", toolId: "tool" },
    allowedCapabilities: ["fixture.echo"],
    invokeCapability: async (capability, input) => {
      calls.push({ capability, input });
      return input;
    },
  });
  assert.deepEqual(output, { value: "hello" });
  assert.deepEqual(calls, [{ capability: "fixture.echo", input: { value: "hello" } }]);
});
