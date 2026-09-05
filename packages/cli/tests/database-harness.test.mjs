import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertIsolatedTestDatabase } from "../../testkit/postgres-test-bridge.mjs";

test("database acceptance refuses remote, ambiguous and company-named databases", () => {
  for (const url of [
    "postgresql://companyos_test@production.example.com/companyos_test",
    "postgresql://companyos_test@localhost/companyos_test",
    "postgresql://companyos_test@127.0.0.1/company",
    "postgresql://administrator@127.0.0.1/companyos_test",
    "https://companyos_test@127.0.0.1/companyos_test",
  ]) assert.throws(() => assertIsolatedTestDatabase(url), /require loopback/);
  assert.equal(assertIsolatedTestDatabase("postgresql://companyos_test@127.0.0.1:5432/companyos_test").hostname, "127.0.0.1");
});

test("missing configuration and explicit database skips fail before any connection", () => {
  const script = new URL("../../../scripts/test-database.mjs", import.meta.url);
  const absent = { ...process.env };
  delete absent.COMPANYOS_TEST_DATABASE_URL;
  delete absent.COMPANYOS_SKIP_DATABASE_TESTS;
  const result = spawnSync(process.execPath, [script.pathname], { env: absent, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /COMPANYOS_TEST_DATABASE_URL is required/);
  const skipped = spawnSync(process.execPath, [script.pathname], { env: { ...absent, COMPANYOS_SKIP_DATABASE_TESTS: "1" }, encoding: "utf8" });
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /Required database tests cannot be disabled/);
});
