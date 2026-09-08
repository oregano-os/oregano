import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inspectAndCompileCompanyTool } from "../tool-sdk/source-inspector.ts";
import { executeIsolatedCompanyTool } from "../tool-sdk/isolated-runner.ts";

const require = createRequire(import.meta.url);
const YAML = require("yaml"), Ajv = require("ajv");

/** Contract fixture harness, using the maintained inspector and isolated Tool runner. */
export function fixtureCompanyTools(toolsDirectory: string) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addFormat("date-time", { type: "string", validate: (value: string) => /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) });
  return async (id: string, input: unknown): Promise<any> => {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw new Error("Fixture Tool identifier is invalid");
    const definition = YAML.parse(readFileSync(join(toolsDirectory, id, "TOOL.md"), "utf8").split(/^---$/m)[1]);
    assert.ok(ajv.validate(definition.input_schema, input), `Input ${id}: ${ajv.errorsText()}`);
    const inspection = inspectAndCompileCompanyTool(readFileSync(join(toolsDirectory, id, "execute.ts"), "utf8"));
    assert.deepEqual(inspection.diagnostics, []);
    const output = await executeIsolatedCompanyTool({ compiledSource: inspection.compiledSource!, input,
      context: { instanceId: "contract-fixture", runId: "fixture-run", stepId: id, agentId: "fixture", toolId: id },
      allowedCapabilities: [], invokeCapability: async () => { throw new Error("Pure fixture computations cannot call a Capability"); } });
    assert.ok(ajv.validate(definition.output_schema, output), `Output ${id}: ${ajv.errorsText()}`);
    return output;
  };
}
