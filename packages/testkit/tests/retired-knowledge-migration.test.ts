import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { prepareCompanyDatabase, qualifyCompanyDatabase, LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS } from "../../state-postgres/database-bootstrap.ts";

const repository = join(import.meta.dirname, "../../..");
const migration = readFileSync(join(repository, "packages/state-postgres/migrations/retire-knowledge.sql"), "utf8");
const testDatabaseUrl = process.env.COMPANYOS_TEST_POSTGRES_URL;
const psql = process.env.COMPANYOS_TEST_PSQL ?? "psql";

test("retirement preview contains an exact target and never exposes database credentials", () => {
  const result = spawnSync(process.execPath, [join(repository, "scripts/retire-knowledge.mjs"), "--preview"], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://test_user:test_password@127.0.0.1:55487/test_retirement" },
  });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.target.schema, "companyos_knowledge");
  assert.equal(preview.target.database, "test_retirement");
  assert.match(preview.target.confirmation, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(result.stdout, /test_user|test_password/);
  const denied = spawnSync(process.execPath, [join(repository, "scripts/retire-knowledge.mjs"), "--confirm", "wrong", "--writers-stopped"], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://test_user:test_password@127.0.0.1:1/test_retirement" },
  });
  assert.notEqual(denied.status, 0);
  assert.doesNotMatch(denied.stderr, /test_password/);
});

test("real PostgreSQL bootstrap, upgrade and atomic retirement preserve Core/Records and reject external dependencies", { skip: !testDatabaseUrl }, async () => {
  const base = new URL(testDatabaseUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(base.hostname), "This destructive fixture is restricted to an explicitly supplied local test server.");
  const database = `companyos_retirement_test_${randomUUID().replaceAll("-", "")}`;
  const runAt = (url: string, sql: string, failure = false) => {
    const result = spawnSync(psql, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--dbname", url], { input: sql, encoding: "utf8" });
    if (!failure) assert.equal(result.status, 0, result.stderr);
    return result;
  };
  runAt(base.href, `CREATE DATABASE "${database}";`);
  const url = new URL(base); url.pathname = `/${database}`;
  const run = (sql: string, failure = false) => runAt(url.href, sql, failure);
  const previousFetch = neonConfig.fetchFunction;
  const previousDatabase = process.env.DATABASE_URL;
  try {
    // Exercise the real retained migration/qualification functions. This test
    // transport executes their parameterized SQL on the isolated local server.
    neonConfig.fetchFunction = async (_input: unknown, options?: RequestInit) => {
      const payload = JSON.parse(String(options?.body));
      const execute = (query: { query: string; params?: unknown[] }) => {
        const literal = (value: unknown) => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
        const statement = query.query.trim().replace(/\$(\d+)\b/g, (_, id: string) => literal(query.params![Number(id) - 1]));
        const returnsRows = /^(select|with)\b/i.test(statement) || /\breturning\b/i.test(statement);
        const sql = !returnsRows ? statement : /^select\b/i.test(statement)
          ? `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM (${statement}) q;`
          : `WITH q AS (${statement}) SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM q;`;
        const output = run(sql).stdout.trim();
        const rows: Record<string, unknown>[] = returnsRows ? JSON.parse(output) : [];
        const keys = Object.keys(rows[0] ?? {});
        return { command: "SELECT", rowCount: rows.length, rowAsArray: true,
          fields: keys.map((name) => ({ name, dataTypeID: typeof rows[0][name] === "boolean" ? 16 : typeof rows[0][name] === "object" && rows[0][name] !== null ? 114 : 25 })),
          rows: rows.map((row) => keys.map((key) => row[key] == null ? null : typeof row[key] === "object" ? JSON.stringify(row[key]) : typeof row[key] === "boolean" ? row[key] ? "t" : "f" : String(row[key]))),
        };
      };
      return new Response(JSON.stringify(payload.queries ? { results: payload.queries.map(execute) } : execute(payload)), { status: 200 });
    };
    process.env.DATABASE_URL = "postgresql://fixture:fixture@ep-fixture.example.neon.tech/fixture";
    const fresh = await prepareCompanyDatabase();
    assert.equal(fresh.operation, "bootstrap");
    assert.equal(fresh.qualification.receiptVersion, 2);
    assert.equal(run("SELECT to_regnamespace('companyos_knowledge') IS NULL;").stdout.trim(), "t");
    assert.equal((await prepareCompanyDatabase()).operation, "verify");
    run(`INSERT INTO companyos.chat_values(key,value) VALUES ('preserved', '{"retained":true}');
      INSERT INTO companyos_records.source_watermarks VALUES ('fixture','source','preserved',now());
      CREATE SCHEMA companyos_knowledge;
      CREATE TABLE companyos_knowledge.pages(id integer primary key, parent_id integer REFERENCES companyos_knowledge.pages(id));
      CREATE TABLE companyos_knowledge.claims(id integer primary key, page_id integer REFERENCES companyos_knowledge.pages(id));
      INSERT INTO companyos_knowledge.pages VALUES (1, NULL);
      INSERT INTO companyos_knowledge.claims VALUES (1, 1);`);
    for (const version of ["1.9.0", "2.0.0", "2.1.0"]) {
      run(`DELETE FROM companyos.schema_manifests;
        INSERT INTO companyos.schema_manifests(manifest_id,manifest_version,manifest_digest,features)
          VALUES ('companyos-postgres','${version}','${LEGACY_COMPANY_DATABASE_MANIFEST_DIGESTS[version]}','{"vector":true}');`);
      assert.equal((await prepareCompanyDatabase()).operation, "upgrade", version);
      assert.equal(run("SELECT count(*) FROM companyos_knowledge.claims;").stdout.trim(), "1");
    }
    assert.equal(run("SELECT count(*) FROM companyos_knowledge.claims;").stdout.trim(), "1", "normal preparation must not delete old data");
    run(migration);
    run(migration);
    await qualifyCompanyDatabase();
    assert.equal(run("SELECT to_regnamespace('companyos_knowledge') IS NULL;").stdout.trim(), "t");
    assert.equal(run("SELECT value->>'retained' FROM companyos.chat_values WHERE key='preserved';").stdout.trim(), "true");
    assert.equal(run("SELECT watermark FROM companyos_records.source_watermarks WHERE instance_id='fixture';").stdout.trim(), "preserved");
    await prepareCompanyDatabase();
    assert.equal(run("SELECT to_regnamespace('companyos_knowledge') IS NULL;").stdout.trim(), "t", "restart must not recreate retired state");

    run(`CREATE SCHEMA companyos_knowledge; CREATE TABLE companyos_knowledge.pages(id integer primary key);
      INSERT INTO companyos_knowledge.pages VALUES (1);
      CREATE TABLE companyos.external_reference(id integer REFERENCES companyos_knowledge.pages(id));
      INSERT INTO companyos.external_reference VALUES (1);`);
    const dependencyFailure = run(migration, true);
    assert.notEqual(dependencyFailure.status, 0);
    assert.equal(run("SELECT count(*) FROM companyos.external_reference;").stdout.trim(), "1");
    assert.equal(run("SELECT count(*) FROM companyos_knowledge.pages;").stdout.trim(), "1", "failure must roll back the entire retirement");
    run("DROP TABLE companyos.external_reference; CREATE VIEW companyos.keep_view AS SELECT * FROM companyos_knowledge.pages;");
    assert.notEqual(run(migration, true).status, 0);
    assert.equal(run("SELECT count(*) FROM companyos.keep_view;").stdout.trim(), "1");
    run("DROP VIEW companyos.keep_view; CREATE FUNCTION companyos_knowledge.unexpected() RETURNS integer LANGUAGE SQL AS 'SELECT 1';");
    assert.notEqual(run(migration, true).status, 0);
    assert.equal(run("SELECT count(*) FROM companyos_knowledge.pages;").stdout.trim(), "1");
    run("DROP FUNCTION companyos_knowledge.unexpected();");
    run(migration);
  } finally {
    neonConfig.fetchFunction = previousFetch;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    runAt(base.href, `DROP DATABASE "${database}";`);
  }
});
