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

const withTemplateLiteral = `
import { defineCompanyTool } from "@companyos/tool-sdk";
type Row = { record_id: string; values: Record<string, unknown> };
const requireFields = (kind: string, row: Row, fields: string[]): void => {
  const missing = fields.filter((field) => row.values[field] === undefined);
  if (missing.length > 0) throw new Error(\`\${kind} row '\${row.record_id}' is missing required values: \${missing.join(", ")}\`);
};
export default defineCompanyTool({
  async execute(input: { rows: Row[] }) {
    for (const row of input.rows) requireFields("participant", row, ["participant_id"]);
    return { count: input.rows.length, label: \`\${input.rows.length} rows, nested \${\`\${input.rows.length > 1 ? "many" : "one"}\`}\` };
  },
});
`;

test("Company Tool inspection accepts template literals with substitutions", () => {
  const result = inspectAndCompileCompanyTool(withTemplateLiteral);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.compiledSource ?? "", /is missing required values/);
});

test("a template literal cannot hide a forbidden identifier from the scanner", () => {
  const hidden = `
import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: unknown) { return input; } });
const a = \`\${1}\`; const leak = process.env.SECRET; const z = \`\`;
`;
  const result = inspectAndCompileCompanyTool(hidden, "hidden.ts");
  assert.ok(result.diagnostics.some((item) => /identifier 'process' is forbidden/.test(item)), JSON.stringify(result.diagnostics));
  assert.equal(result.compiledSource, undefined);
});

test("regexp punctuation is not a template and division cannot hide source", () => {
  const source = 'import { defineCompanyTool } from "@companyos/tool-sdk";\n'
    + 'const clean = (text: string) => text.replace(/[\\\\`*_]/g, "");\n'
    + 'export default defineCompanyTool({ execute(input: { value: string }) { return { value: clean(input.value), ratio: 8 / 2 / 2 }; } });';
  assert.deepEqual(inspectAndCompileCompanyTool(source).diagnostics, []);
  const hidden = 'import { defineCompanyTool } from "@companyos/tool-sdk";\n'
    + 'export default defineCompanyTool({ execute(input: unknown) { return input; } });\n'
    + 'const a = /`/; const leak = process.env.SECRET; const z = /`/;';
  const result = inspectAndCompileCompanyTool(hidden);
  assert.ok(result.diagnostics.some((item) => /identifier 'process' is forbidden/.test(item)), JSON.stringify(result));
  assert.equal(result.compiledSource, undefined);
  const divided = hidden.replace('const a = /`/; const leak = process.env.SECRET; const z = /`/;', 'const ratio = 8 / process.pid / 2;');
  assert.ok(inspectAndCompileCompanyTool(divided).diagnostics.some((item) => /identifier 'process' is forbidden/.test(item)));
});

test("type-only imports remain subject to source inspection after type stripping", () => {
  const source = 'import type { Stats } from "node:fs"; import { defineCompanyTool } from "@companyos/tool-sdk"; '
    + 'export default defineCompanyTool({ execute(input: unknown) { return input; } });';
  assert.ok(inspectAndCompileCompanyTool(source).diagnostics.some((item) => /only the named defineCompanyTool import/.test(item)));
});

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
