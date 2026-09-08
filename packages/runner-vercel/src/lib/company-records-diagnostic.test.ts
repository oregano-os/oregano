import assert from "node:assert/strict";
import test from "node:test";
import { recordsOperatorDiagnostic } from "./company-records-diagnostic.ts";
import { POST } from "../app/api/records/operations/route.ts";

test("Records diagnostics preserve actionable provider failures and remove Instance credentials", () => {
  const token = "fixture/private?provider=token&private+value", database = "postgres://owner:fixture-password@db.example/company";
  const message = `Monday query rejected field 'owners'; ${token}; ${encodeURIComponent(token)}; ${database}; Bearer independent-token; xoxb-fixture-token`;
  const result = recordsOperatorDiagnostic(new Error(message), { MONDAY_API_TOKEN: token, DATABASE_URL: database }).message;
  assert.match(result, /Monday query rejected field 'owners'/);
  for (const secret of [token, encodeURIComponent(token), database, "independent-token", "xoxb-fixture-token", "fixture-password"]) assert.equal(result.includes(secret), false);
});

test("Records diagnostics remove escaped and multiline secrets before bounding output", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nfixture-long-private-material\n-----END PRIVATE KEY-----";
  const value = recordsOperatorDiagnostic(new Error(`${key}\n${JSON.stringify(key)}\nhttps://user:password@provider.example/path`), { GITHUB_PRIVATE_KEY: key }).message;
  assert.equal(value.includes("fixture-long-private-material"), false);
  assert.equal(value.includes("password"), false);
  assert.equal(value.includes("\n"), false);
  assert.ok(recordsOperatorDiagnostic(new Error("x".repeat(5000)), {}).message.length <= 1500);
  assert.match(recordsOperatorDiagnostic(new Error("x".repeat(65537)), {}).message, /size limit/);
  assert.deepEqual(recordsOperatorDiagnostic({ message: "untrusted object" }), { message: "Unexpected Records operation failure." });
});

test("an unauthenticated Records request cannot obtain operator diagnostics", async () => {
  const response = await POST(new Request("https://synthetic.example/api/records/operations", { method: "POST", body: "invalid" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
});
