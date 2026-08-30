import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const storeSource = readFileSync(new URL("../../state-postgres/source-pipeline-store.ts", import.meta.url), "utf8");

test("successful Source status records freshness without fabricating success for another state", () => {
  assert.match(storeSource, /setSourceStatus[\s\S]*last_successful_sync = case when \$\{status\} = 'healthy' then now\(\) else last_successful_sync end/);
  assert.doesNotMatch(storeSource, /last_successful_sync\s*=\s*now\(\)[\s\S]*where source_id/);
});
