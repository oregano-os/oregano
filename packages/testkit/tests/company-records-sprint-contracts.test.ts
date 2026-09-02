import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import type { JsonSchema } from "../../capabilities/contracts.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { STANDARD_COMMUNICATION_TOOLS } from "../../standard-tools/communication.ts";
import { STANDARD_RECORDS_TOOLS } from "../../standard-tools/records.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../../standard-tools/work-items.ts";

const schema = (name: string): JsonSchema => JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8")) as JsonSchema;

test("Company Records and Sprint JSON Schemas accept generic declarations and reject provider secrets", () => {
  const source = {
    schema_version: 1,
    id: "fixture-items",
    record_type: "work-item",
    connection: "connections/board.md",
    resource_binding: "primary-board",
    delivery: "webhook",
    identity: { source_field: "id" },
    fields: [{ target: "status", source: "columns.state", value_type: "status" }],
    access: { read_groups: ["delivery"], write_roles: ["process-owner"] },
  };
  assert.deepEqual(validateJsonSchemaValue(schema("company-record-source-v1.schema.json"), source), []);
  const errors = validateJsonSchemaValue(schema("company-record-source-v1.schema.json"), { ...source, api_token: "forbidden" });
  assert.ok(errors.some((error) => error.includes("api_token") && error.includes("not allowed")));

  const sprint = {
    schema_version: 1,
    id: "weekly-delivery",
    participants: { projection: "participants", absence_policy: "exclude-approved" },
    work_items: { projection: "sprint-items", master_group: "current", ready_status: "ready", closed_statuses: ["done"] },
    calendar: { timezone: "UTC", business_calendar_ref: "default", holiday_shift: "previous-business-day" },
    close: { weekday: "friday", reminder_time: "14:00", complete_by: "16:00", report_at: "17:00" },
    submission: { task_line_rule: "one-per-committed-task", after_report: "provider-only" },
    effort: "actual-hours",
    rollover: { eligible: "all-open" },
    delivery: { shared_thread: true, channel_binding: "sprint-channel", direct_binding: "sprint-direct" },
  };
  assert.deepEqual(validateJsonSchemaValue(schema("sprint-configuration-v1.schema.json"), sprint), []);
});

test("the Core catalog owns provider-neutral records, work-item, and communication contracts", () => {
  const byId = new Map(CORE_CAPABILITY_CATALOG.map((contract) => [contract.id, contract]));
  assert.equal(byId.get("records.query")?.mode, "read");
  assert.equal(byId.get("work-item.read")?.minimumRisk, "R0");
  assert.equal(byId.get("work-item.update")?.idempotency, "required");
  assert.equal(byId.get("work-item.comment")?.idempotency, "required");
  assert.equal(byId.get("communication.message.publish")?.minimumRisk, "R2");
  assert.equal(byId.get("communication.message.publish")?.idempotency, "required");
  assert.ok(validateJsonSchemaValue(byId.get("work-item.update")!.inputSchema, {
    resource_binding: "primary-board",
    work_item_id: "item-1",
    changes: { status: "done" },
    expected_version: "v1",
  }).length === 0);
  assert.deepEqual(validateJsonSchemaValue(byId.get("communication.message.publish")!.inputSchema, {
    destination_binding: "sprint-channel",
    content: "The weekly close is ready.",
    format: "plain-text",
  }), []);
});

test("the reusable Sprint standard Tools are available for Artifact ToolSet resolution", () => {
  assert.deepEqual(STANDARD_RECORDS_TOOLS.map((tool) => tool.contract.runtimeId), ["oregano:records/query"]);
  assert.deepEqual(STANDARD_WORK_ITEM_TOOLS.map((tool) => tool.contract.runtimeId), [
    "oregano:work-items/read",
    "oregano:work-items/update",
    "oregano:work-items/comment",
  ]);
  assert.deepEqual(STANDARD_COMMUNICATION_TOOLS.map((tool) => tool.contract.runtimeId), ["oregano:communications/publish"]);
});
