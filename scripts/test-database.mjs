import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startPostgresTestBridge } from "../packages/testkit/postgres-test-bridge.mjs";

if (process.env.COMPANYOS_SKIP_DATABASE_TESTS === "1") throw new Error("Required database tests cannot be disabled.");
const connectionString = process.env.COMPANYOS_TEST_DATABASE_URL;
if (!connectionString) throw new Error("COMPANYOS_TEST_DATABASE_URL is required; no environment-file or production fallback is allowed.");
const suites = [
  "packages/testkit/tests/database-transport.test.ts",
  "packages/testkit/tests/record-query-postgres.test.ts",
  "packages/testkit/tests/approval-atomicity.test.ts",
  "packages/testkit/tests/durable-state-postgres.test.ts",
  "packages/testkit/tests/workflow-state-postgres.test.ts",
  "packages/testkit/tests/company-database-bootstrap.test.ts",
  "packages/testkit/tests/company-brain-persistence.test.ts",
  "packages/testkit/tests/company-brain-entity-identity.test.ts",
];
const bridge = await startPostgresTestBridge(connectionString);
try {
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../packages/testkit/postgres-test-preload.mjs", import.meta.url)),
    "--experimental-strip-types", "--test", "--test-concurrency=1", "--test-reporter=tap", ...suites], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: connectionString, RUN_DATABASE_TESTS: "1", COMPANYOS_REQUIRE_DATABASE_TESTS: "1",
      COMPANYOS_TEST_SQL_ENDPOINT: bridge.endpoint },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const skipped = output.match(/^# skipped (\d+)$/m);
  if (code !== 0 || !skipped || Number(skipped[1]) !== 0 || /# SKIP\b/.test(output)) {
    throw new Error("Required Postgres suite failed, omitted its summary, or skipped a test.");
  }
} finally {
  await bridge.close();
}
