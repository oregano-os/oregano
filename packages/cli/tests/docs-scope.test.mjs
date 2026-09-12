import assert from "node:assert/strict";
import test from "node:test";
import { scopeFindings, inspectDocumentationScopes } from "../src/docs-scope.mjs";
const doc = (body, data = {}) => ({ relative: "specifications/example.md", body, data: { authority: "canonical", ...data } });
test("general contracts reject host, chat, model and database assumptions", () => {
  for (const name of ["Vercel", "Slack", "Anthropic", "PostgreSQL", "MONDAY_API_TOKEN"]) assert.equal(inspectDocumentationScopes([doc(`Requires ${name}.`)]).length, 1);
});
test("references and linked explicit implementation examples are allowed", () => {
  assert.deepEqual(scopeFindings(doc("[Slack adapter](../operations/slack.md)")), []);
  assert.deepEqual(scopeFindings(doc("::: implementation-example\nUse Slack here. See [adapter](../operations/slack.md).\n:::")), []);
  assert.equal(scopeFindings(doc("::: implementation-example\nUse Slack.\n:::"))[0].code, "DOC031");
  assert.equal(scopeFindings(doc("::: implementation-example\nUse Slack."))[0].code, "DOC031");
});
test("provider documents require explicit implementation identity", () => {
  assert.deepEqual(scopeFindings(doc("Use Slack.", { implementation_scope: "provider", providers: ["slack"] })), []);
  assert.equal(scopeFindings(doc("Use Slack.", { implementation_scope: "provider" }))[0].code, "DOC030");
  assert.equal(scopeFindings(doc("", { implementation_scope: "whatever" }))[0].code, "DOC030");
});
test("legacy debt does not excuse new, moved, changed or duplicated assumptions", () => {
  const original = doc("Use Slack."), baseline = scopeFindings(original);
  assert.equal(inspectDocumentationScopes([original], baseline).length, 0);
  assert.equal(inspectDocumentationScopes([doc("Requires Slack.")], baseline).length, 1);
  assert.equal(inspectDocumentationScopes([{ ...original, relative: "architecture/new.md" }], baseline).length, 1);
  assert.equal(inspectDocumentationScopes([doc("Use Slack.\nUse Slack.")], baseline).length, 1);
});
