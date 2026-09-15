import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { materializeBrainWorkflow, type BrainWorkflowInputs } from "../../../scripts/materialize-brain-workflow.ts";
import { executeIsolatedCompanyTool } from "../../tool-sdk/isolated-runner.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { loadCompanyTool } from "../../companyos-builder/workspace-loader.ts";
import { workspaceDocument } from "../../companyos-builder/workspace-files.ts";
// @ts-expect-error The maintained Package inspector is a JavaScript Workbench module.
import { inspectCompanyOSPackage } from "../../cli/src/package-inspector.mjs";

const input: BrainWorkflowInputs = {
  prompt: { agent_id: "analyst", perspective: "A fictional design studio and its collaborators.", directories: { person_directory: "people", company_directory: "companies", concept_directory: "topics", meeting_directory: "meetings", evidence_directory: "sources" }, filing_categories: ["original_thinking", "business", "low_value"] },
  source_projection: "studio-sources", transcripts: { mode: "bounded", max_transcripts: 4, meeting_date: { start_at: "2026-01-01T00:00:00+01:00", end_at: null } },
  segment_characters: 30_000, history_from: "2026-02-01T00:00:00Z",
  triage: { filing_categories: ["original_thinking", "business", "low_value"], deep_filing: ["original_thinking"], deep_quality_at_least: 7, deep_emotional_at_least: 8, deep_business_at_least: 8, skip_filing: ["low_value"], skip_scores_below: 2 },
};

test("portable Brain adoption uses reviewed company inputs and compiles every restricted Tool", () => {
  const before = structuredClone(input), result = materializeBrainWorkflow(input);
  assert.deepEqual(input, before, "Materialization does not mutate caller policy");
  const workflow = workspaceDocument(result.materials, "workflows/brain-import.md").data;
  const config = YAML.parse(result.materials["workflows/brain-import/config.yaml"]);
  assert.equal(workflow.owner, "agents/analyst"); assert.equal(workflow.trigger, "operator"); assert.equal(workflow.steps.length, 10);
  assert.equal(config.source_projection, "studio-sources"); assert.equal(config.transcripts.max_transcripts, 4);
  assert.equal(config.transcripts.meeting_date.start_at, "2025-12-31T23:00:00.000Z");
  assert.equal(config.source_history.from, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(config.triage, input.triage); assert.equal(config.page_directories.concept, "topics");
  const tools = result.report.requirements.tools.filter(id => id.startsWith("company:"));
  assert.equal(tools.length, 7);
  for (const id of tools) {
    const tool = loadCompanyTool(result.materials, "analyst", id.slice(8));
    assert.equal(tool.contract.agentId, "analyst"); assert.equal(tool.contract.risk, "R0");
    assert.ok(tool.contract.capabilities.every(capability => ["language.generate", "evidence.query"].includes(capability)));
  }
  assert.equal(result.prompts.length, 21);
  assert.equal(result.report.activated, false); assert.equal(result.report.grants_applied, false);
  assert.equal(result.report.provider_bindings_applied, false); assert.equal(result.report.admission_created, false);
  assert.ok(Object.keys(result.materials).every(path => /^(agents\/analyst\/|workflows\/brain-import)/.test(path)));
  assert.ok(!JSON.stringify(result.materials).includes("agents/brain-owner"));
});

test("another company can change vocabulary and the history window without altering the Core", () => {
  const alternate = structuredClone(input); alternate.prompt.agent_id = "researcher";
  alternate.prompt.perspective = "A fictional research cooperative.";
  alternate.prompt.directories = { person_directory: "researchers", company_directory: "institutions", concept_directory: "subjects", meeting_directory: "sessions", evidence_directory: "references" };
  alternate.source_projection = "research-notes"; alternate.transcripts.max_transcripts = 7;
  alternate.transcripts.meeting_date.start_at = "2025-10-01T00:00:00Z";
  const first = materializeBrainWorkflow(input), next = materializeBrainWorkflow(alternate);
  assert.notEqual(first.report.inputs_digest, next.report.inputs_digest);
  const config = YAML.parse(next.materials["workflows/brain-import/config.yaml"]);
  assert.equal(config.transcripts.max_transcripts, 7); assert.equal(config.transcripts.meeting_date.start_at, "2025-10-01T00:00:00.000Z");
  assert.equal(config.page_directories.meeting, "sessions"); assert.equal(config.page_directories.source, "references");
  assert.equal(config.prompts.normalization.deep, "agents/researcher/skills/brain-meeting-normalize-deep/SKILL.md");
  assert.equal(config.prompts.source_reconciliation.reasoning, "agents/researcher/skills/brain-source-reconcile/SKILL.md");
  assert.equal(next.report.admission_created, false, "Changing date/count alone does not admit new sources");
  for (const [path, text] of Object.entries(first.materials).filter(([path]) => path.includes("/tools/"))) {
    assert.equal(next.materials[path.replace("agents/analyst/", "agents/researcher/")], text, "Generic Tool code has no company substitution");
  }
});

test("missing, inconsistent, unsafe and unbounded company inputs fail before adoption", () => {
  for (const change of [
    (x: any) => { delete x.transcripts; }, (x: any) => { x.transcripts.max_transcripts = 0; },
    (x: any) => { x.history_from = null; }, (x: any) => { x.history_from = "2026-02-30T00:00:00Z"; },
    (x: any) => { x.segment_characters = 60_001; }, (x: any) => { x.source_projection = "../sources"; },
    (x: any) => { x.triage.deep_business_at_least = 11; }, (x: any) => { x.triage.deep_filing = ["unknown"]; },
    (x: any) => { x.triage.filing_categories = ["different"]; }, (x: any) => { x.prompt.agent_id = "../../other"; },
    (x: any) => { x.activate = true; },
  ]) { const invalid = structuredClone(input); change(invalid); assert.throws(() => materializeBrainWorkflow(invalid)); }
});

test("the Brain Blueprint remains independently inspectable and declarative", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = inspectCompanyOSPackage(fileURLToPath(new URL("../../blueprints/brain/", import.meta.url)), root);
  assert.deepEqual(report.diagnostics, []); assert.equal(report.package.kind, "blueprint");
  assert.equal(report.package.trust_tier, "declarative"); assert.equal(report.package.installation, "not-implemented");
});


test("triage retains every source character and distinguishes complete coverage from a segment", async () => {
  const result = materializeBrainWorkflow(input), tool = loadCompanyTool(result.materials, "analyst", "brain-prepare-source");
  for (const text of ["A very short retained utterance.", "Line \"\\\n😀".repeat(10000)]) {
    const source = { identity: "synthetic-meeting", version: "synthetic-version", complete: true, kind: "meeting", text,
      original_url: "https://example.invalid/transcript", occurred_at: "2030-01-01T00:00:00.000Z" };
    const output = await executeIsolatedCompanyTool({ compiledSource: tool.compiledSource, input: {
      identity: source.identity, version: source.version, segment_characters: 60000,
      records: { rows: [{ values: source, source_version_id: "a".repeat(64) }], access_decision: { allowed: true } },
    }, context: { instanceId: "synthetic", runId: "coverage", stepId: "prepare", agentId: "analyst", toolId: tool.contract.runtimeId },
    allowedCapabilities: [], invokeCapability: async () => { throw new Error("No provider access"); } }) as any;
    assert.deepEqual(validateJsonSchemaValue(tool.contract.outputSchema, output), []);
    assert.equal(output.segments.map((s: any) => s.data.segment.text).join(""), text);
    for (const segment of output.segments) {
      assert.equal(segment.data.source.context.companyos_retained_source.complete, true);
      assert.equal(segment.data.source.context.companyos_retained_source.segments, output.segments.length);
      assert.equal(segment.data.source.context.companyos_retained_source.characters, text.length);
      assert.ok(JSON.stringify(segment.data).length <= 100000);
    }
  }
});

test('incremental completion checks actual saved pages and returns correction feedback', async () => {
 const result=materializeBrainWorkflow(input), tool=loadCompanyTool(result.materials,'analyst','brain-check-agent-completion');
 const source='sources/import-example',meeting='meetings/example',person='people/example';
 const evidence='source_identity: "source:1"\nsource_version: "v1"\nrecord_version_id: '+ 'a'.repeat(64);
 const meetingText='A sourced meeting. [['+source+']] [['+person+']]';
 const entity='A participant.\n<!-- timeline -->\n- Meeting [['+meeting+']] [['+source+']]';
 const pages=[{path:'brain/'+source+'.md',markdown:evidence},{path:'brain/'+meeting+'.md',markdown:meetingText},{path:'brain/'+person+'.md',markdown:entity}];
 const task={source:{identity:'source:1',version:'v1',kind:'meeting',context:{companyos_record_version:'a'.repeat(64)}},evidence:{slug:source},prior:{requests:[]}};
 const facts={source_identity:'source:1',source_version:'v1',status:'ingested',pages:[source,meeting,person],meetings:[{slug:meeting,attendees:[person],entities:[]}],
  verification:['V1','V2','V3','V4','V5','V6'].map(check=>({check,status:'passed',detail:'Synthetic check evidence.'})),gaps:[]};
 const calls:any[]=[{name:'oregano_brain_remember',input:{provenance:{source_id:'source:1',source_version:'v1'},changes:{pages}},output:{status:'saved',saved_commit:'b'.repeat(40),sync_status:'indexed',changed_paths:pages.map(page=>page.path)}},
  ...pages.map(page=>({name:'oregano_brain_entity',output:{status:'found',found:true,page:{slug:page.path.slice(6,-3),markdown:page.markdown},indexed_revision:{git_commit:'b'.repeat(40)}}}))];
 const check=async(value:any)=>executeIsolatedCompanyTool({compiledSource:tool.compiledSource,input:value,context:{instanceId:'synthetic',runId:'workflow:test',stepId:'process',agentId:'analyst',toolId:tool.contract.runtimeId},allowedCapabilities:[],invokeCapability:async()=>{throw Error('Pure validation cannot call a provider');}}) as Promise<any>;
 assert.equal((await check({context:{task,calls},facts})).accepted,true);
 assert.match((await check({context:{task,calls:calls.slice(0,-1)},facts})).feedback,/Read every/);
 const stale=[calls[1],calls[0],...calls.slice(2)];assert.equal((await check({context:{task,calls:stale},facts})).accepted,false);
 const premature={...facts,verification:facts.verification.slice(1)};assert.match((await check({context:{task,calls},facts:premature})).feedback,/V1–V6/);
 const mismatch=structuredClone(calls);mismatch.at(-1).output.page.markdown='Unrelated current content';assert.match((await check({context:{task,calls:mismatch},facts})).feedback,/differs/);
});
