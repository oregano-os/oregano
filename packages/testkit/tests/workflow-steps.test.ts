import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { validateWorkflowAuthoring } from "../../companyos-builder/workflow-authoring.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/lindenhof-studio");
const core = resolve(import.meta.dirname, "../../..");
const close = "workflows/friday-close.compact.md";
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const document = (root: string, path: string, mutate: (value: any) => void) => {
  const raw = read(root, path); const match = /^---\n([\s\S]*?)\n---\n/.exec(raw)!;
  const value = YAML.parse(match[1]!); mutate(value);
  writeFileSync(join(root, path), `---\n${YAML.stringify(value)}---\n${raw.slice(match[0].length)}`);
};
const declaration = (root: string, path: string, mutate: (value: any) => void) => {
  const value = YAML.parse(read(root, path)); mutate(value); writeFileSync(join(root, path), YAML.stringify(value));
};
const workflow = (root: string) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(read(root, close))![1]!);
const toolFile = (root: string, tool: string) => `${workflow(root).owner}/tools/${tool}/TOOL.md`;
const configFile = (root: string) => workflow(root).config;
const scheduleFile = (root: string) => YAML.parse(read(root, configFile(root))).calendar.business_calendar_ref;
const mutate = (edit: (root: string) => void, expected: RegExp) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-authoring-"));
  try {
    cpSync(fixture, root, { recursive: true }); edit(root);
    let issues: string[];
    try { issues = validateWorkflowAuthoring(root); } catch (error) { issues = [String(error)]; }
    assert.ok(issues.some((issue) => expected.test(issue)), `Expected ${expected}; got ${JSON.stringify(issues)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
};

test("executable fixture validates through the full CLI and existing prose still validates", () => {
  assert.deepEqual(validateWorkflowAuthoring(fixture), []);
  for (const workspace of [fixture, resolve(import.meta.dirname, "../fixtures/acme-casas")]) {
    const result = spawnSync(process.execPath, ["packages/cli/src/cli.mjs", "validate", workspace, "--format", "json"], { cwd: core, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

const cases: [string, (root: string) => void, RegExp][] = [
  ["unknown top-level field", (r) => document(r, close, (v) => { v.exports = ["report"]; }), /exports.*not allowed/],
  ["unknown step option", (r) => document(r, close, (v) => { v.steps[0].typo = "ignored"; }), /unknown option 'typo'/],
  ["duplicate steps", (r) => document(r, close, (v) => { v.steps[1] = v.steps[0]; }), /identities must be distinct/],
  ["backward control flow", (r) => document(r, close, (v) => { v.steps.at(-1).then = Object.keys(v.steps[0])[0]; }), /backward control flow/],
  ["unreachable step", (r) => document(r, close, (v) => { v.steps[0].then = "end"; }), /unreachable/],
  ["skipped dependency", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["await-report"]).after = "chase"; }), /after dependency can be skipped/],
  ["missing grant", (r) => document(r, `${workflow(r).owner}/instructions.md`, (v) => { v.tools = v.tools.filter((t: string) => t !== "oregano:directory/members"); }), /not granted/],
  ["wrong marker owner", (r) => writeFileSync(join(r, close), read(r, close).replace(/\[([^,]+), R0\]/, "[wrong-owner, R0]")), /marker owner/],
  ["wrong marker risk", (r) => writeFileSync(join(r, close), read(r, close).replace(", R3]", ", R0]")), /body marker says R0.*R3/],
  ["marker order", (r) => writeFileSync(join(r, close), read(r, close).replace("<!-- step:snapshot-directory -->", "<!-- step:participant-roles -->")), /body markers/],
  ["missing input", (r) => document(r, close, (v) => { delete v.steps.find((s: any) => s["close-view"]).input; }), /required property/],
  ["wrong literal type", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["close-view"]).input.cutoff = 42; }), /must be string/],
  ["unknown output", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["report"]).vars.report_text = "$steps.close-view.unknown"; }), /not a field/],
  ["root consumes its own output", (r) => document(r, close, (v) => { v.defaults.thread = "$steps.open-close-thread.thread_reference"; }), /current or future output/],
  ["expression instead of reference", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["close-view"]).input.cutoff = "$trigger.instant + 1"; }), /malformed reference/],
  ["prototype reference", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["close-view"]).input.cutoff = "$config.constructor.name"; }), /malformed reference/],
  ["undefined configuration", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["close-view"]).input.cutoff = "$config.missing"; }), /not defined in config/],
  ["message input instead of vars", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["report"]).input = {}; }), /message step must use vars|unknown option 'input'/],
  ["missing template", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["report"]).template = "unknown/missing.md"; }), /ENOENT|existing owner Skill asset/],
  ["template traversal", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["report"]).template = "../../outside.md"; }), /existing owner Skill asset/],
  ["missing timeout", (r) => document(r, close, (v) => { delete v.steps.find((s: any) => s["approve-rollover"]).timeout; }), /decision requires timeout/],
  ["empty updates reach decision", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["rollover-route"]).none = "approve-rollover"; }), /must send 'none' to 'end'/],
  ["approval bypass", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["apply-rollover"]).input.updates = "$steps.prepare-rollover.updates"; }), /must come from a bound decision/],
  ["omitted route outcome", (r) => document(r, close, (v) => { delete v.steps.find((s: any) => s["rollover-route"]).some; }), /no branch for outcome/],
  ["unknown schedule trigger", (r) => document(r, close, (v) => { v.trigger = "schedule:unknown"; }), /trigger is not declared/],
  ["missing wait trigger", (r) => document(r, close, (v) => { v.steps.find((s: any) => s["await-chase"]).for = "schedule:unknown"; }), /undeclared trigger/],
  ["colliding schedule variant", (r) => declaration(r, scheduleFile(r), (v) => { v.triggers.push(v.triggers[0]); }), /fire twice/],
  ["invalid calendar date", (r) => declaration(r, scheduleFile(r), (v) => { v.holiday_calendar.years["2026"].push("2026-02-30"); }), /valid date/],
  ["unknown timezone", (r) => declaration(r, scheduleFile(r), (v) => { v.timezone = "Invented/Zone"; }), /IANA timezone/],
  ["configuration expressions", (r) => declaration(r, configFile(r), (v) => { v.effort = "$steps.computed"; }), /literal values/],
  ["unguaranteed required row value", (r) => document(r, toolFile(r, "participant-view"), (v) => { v.output_schema.properties.rows.items.properties.values.required = v.output_schema.properties.rows.items.properties.values.required.filter((field: string) => field !== "participant_id"); }), /participant_id is not guaranteed/],
  ["nullable row value", (r) => document(r, toolFile(r, "participant-view"), (v) => { v.output_schema.properties.rows.items.properties.values.properties.participant_id = { type: ["string", "null"] }; }), /null.*do not fit/],
  ["forbidden code", (r) => { const path = toolFile(r, "participant-view").replace("TOOL.md", "execute.ts"); writeFileSync(join(r, path), read(r, path) + "\nfetch('https://example.test');\n"); }, /fetch/],
  ["symlink declaration", (r) => { const name = join(r, "workflows", "link.md"); symlinkSync(join(fixture, close), name); }, /symlinks/],
];
for (const [name, edit, expected] of cases) test(`workflow authoring rejects ${name}`, () => mutate(edit, expected));

test("workflow authoring rejects selector override metadata", () => mutate((r) => document(r, close, (v) => { v.steps[0].tool = "wait"; }), /cannot override/));
test("workflow authoring raises a Company Tool to its Capability risk minimum", () => mutate((r) => document(r, toolFile(r, "participant-view"), (v) => { v.capabilities = ["communication.message.publish"]; }), /body marker says R0.*R2/));
test("workflow authoring rejects params absent from one schedule variant", () => mutate((r) => declaration(r, scheduleFile(r), (v) => { const trigger = v.triggers.find((t: any) => t.params); delete trigger.params.readiness; }), /not declared on every trigger variant/));
test("workflow authoring rejects incompatible array item types", () => mutate((r) => document(r, toolFile(r, "rollover-changes"), (v) => { v.output_schema.properties.updates.items.properties.work_item_id = { type: "number" }; }), /work_item_id.*number.*string/));
