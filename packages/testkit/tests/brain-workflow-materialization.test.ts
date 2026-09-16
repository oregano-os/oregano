import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { sha256 } from "../../runtime/canonical.ts";
import { readFileSync } from "node:fs";
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
  assert.equal(workflow.owner, "agents/analyst"); assert.equal(workflow.trigger, "operator"); assert.equal(workflow.steps.length, 11);
  assert.equal(workflow.steps.find((step: any) => Object.keys(step)[0] === "agent-context")?.input?.processing_instant, "$trigger.instant");
  assert.equal(config.source_projection, "studio-sources"); assert.equal(config.transcripts.max_transcripts, 4);
  assert.equal(config.transcripts.meeting_date.start_at, "2025-12-31T23:00:00.000Z");
  assert.equal(config.source_history.from, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(config.triage, input.triage); assert.equal(config.page_directories.concept, "topics");
  const tools = result.report.requirements.tools.filter(id => id.startsWith("company:"));
  assert.equal(tools.length, 9);
  for (const id of tools) {
    const tool = loadCompanyTool(result.materials, "analyst", id.slice(8));
    assert.equal(tool.contract.agentId, "analyst"); assert.equal(tool.contract.risk, id === "company:brain-one-shot" ? "R1" : "R0");
    assert.ok(tool.contract.capabilities.every(capability => ["language.generate", "evidence.query", "records.query", "brain.recall", "brain.entity", "brain.remember"].includes(capability)));
  }
  assert.equal(result.prompts.length, 21);
  assert.equal(config.agent.budget.turns, 12);
  assert.equal(config.prompts.one_shot, undefined);
  assert.equal(config.agent.budget.total_input_bytes, 2000000);
  assert.equal(config.agent.budget.no_progress_turns, 2);
  assert.ok(!JSON.stringify(workflow).includes("one-shot"));
  assert.match(result.materials["agents/analyst/skills/brain-task/SKILL.md"], /trusted `processing_day`/);
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

test("content routing is provider-independent and unavailable discovery cannot start a model", async () => {
  const result = materializeBrainWorkflow(input), config = YAML.parse(result.materials["workflows/brain-import/config.yaml"]);
  const tool = loadCompanyTool(result.materials, "analyst", "brain-ingestion-router");
  const route = (kind: string, identity = "provider-a:item") => executeIsolatedCompanyTool({ compiledSource: tool.compiledSource,
    input: { source: { kind, identity }, routes: config.ingestion.routes },
    context: { instanceId: "synthetic", runId: "router", stepId: "router", agentId: "analyst", toolId: tool.contract.runtimeId },
    allowedCapabilities: [], invokeCapability: async () => { throw Error("Router must not call a provider or model"); } });
  assert.deepEqual(await route("meeting"), await route("meeting", "provider-b:different-item"));
  assert.deepEqual((await route("meeting") as any).instructions, config.ingestion.routes.meeting);
  for (const [kind, skill] of [["discussion", "source-work"], ["article", "idea-work"], ["idea", "idea-work"], ["document", "media-work"], ["media", "media-work"]]) {
    const selected = (await route(kind!) as any).instructions;
    assert.ok(selected.some((path: string) => path.endsWith(`/brain-${skill}/SKILL.md`)));
    assert.ok(!selected.some((path: string) => path.includes("meeting-work")));
  }
  await assert.rejects(route("publication"), /Publication enumeration/);
  await assert.rejects(route("unknown"), /Unsupported content kind/);
  const workflow = workspaceDocument(result.materials, "workflows/brain-import.md").data;
  assert.equal(workflow.steps[2]["ingestion-router"], "company:brain-ingestion-router");
  assert.equal(workflow.steps.find((s: any) => s["process-source"])?.instruction_selection, "$steps.ingestion-router.instructions");
  assert.equal(workflow.steps.some((s: any) => s["choose-synthesis"]), false);
});

test("one-shot meeting synthesis makes one model call, writes through Brain and verifies Markdown", async () => {
  // Historical retained artifacts still require their old Tool contract tests.
  const result = materializeBrainWorkflow(input);
  for (const file of ["TOOL.md", "execute.ts"]) result.materials[`agents/analyst/tools/brain-one-shot/${file}`] = readFileSync(new URL(`../../cli/content/templates/brain-import/tools/brain-one-shot/${file}`, import.meta.url), "utf8");
  const tool = loadCompanyTool(result.materials, "analyst", "brain-one-shot");
  const revision = { git_commit: "a".repeat(40), configuration_digest: "b".repeat(64), generation: "g", sequence: 1, indexed_at: "2030-01-02T00:00:00Z" };
  const sourceSlug = "sources/import-example", meetingSlug = "meetings/example", personSlug = "people/alex";
  const source = { identity: "source:example", version: "v1", kind: "meeting", occurred_at: "2030-01-01T12:00:00Z",
    original_url: "https://example.invalid/meeting", context: { participants: ["Alex"] } };
  const evidence = { slug: sourceSlug, markdown: "---\ntype: source\ntitle: Example source\nsource_identity: source:example\nsource_version: v1\n---\n\n[Original source](https://example.invalid/meeting)\n" };
  const task = { source, evidence, original_text: "Alex discussed a first design goal. No decision or action was recorded.",
    triage: { route: "reasoning", coverage_complete: true, items: [{ classification: { one_line_summary: "First design goal" } }] },
    prior: { requests: [] }, directories: { source: "sources", meeting: "meetings", person: "people", company: "companies", concept: "topics" } };
  const proposal = { source_identity: source.identity, source_version: source.version,
    pages: [
      { slug: meetingSlug, markdown: "---\ntype: meeting\ntitle: Design goal\nlang: en\ntags: [meeting, design]\n---\n\n## Summary\nAlex discussed the goal. [[" + sourceSlug + "|original]] [[" + personSlug + "|Alex]]\n## Key Decisions\nNone evidenced.\n## Action Items\nNone evidenced.\n## Notable Quotes\n> \"Alex discussed a first design goal.\" — Alex\n> \"An invented quote.\" — Alex\n" },
      { slug: personSlug, markdown: "---\ntype: person\ntitle: Alex\nlang: en\naliases: [Alex]\n---\n\nAlex discussed a goal. [[" + sourceSlug + "|original]]\n<!-- timeline -->\n- Discussed the goal in [[" + meetingSlug + "|meeting]] [[" + sourceSlug + "|original]]\n" },
    ], meetings: [{ slug: meetingSlug, attendees: [personSlug], entities: [] }],
    verification: ["V1", "V2", "V3", "V4", "V5", "V6"].map(check => ({ check, status: "passed", detail: "Synthetic source evidence." })), gaps: [] };
  let modelCalls = 0, writeCalls = 0;
  const saved = new Map<string, string>();
  const run = (modelText: string) => executeIsolatedCompanyTool({ compiledSource: tool.compiledSource,
    input: { task, route: "reasoning", prompt_paths: { reasoning: "agents/analyst/skills/brain-one-shot-reasoning/SKILL.md",
      deep: "agents/analyst/skills/brain-one-shot-deep/SKILL.md" }, processing_instant: "2030-01-02T10:00:00Z" },
    context: { instanceId: "synthetic", runId: "workflow:" + "c".repeat(64), stepId: "synthesize-source", agentId: "analyst", toolId: tool.contract.runtimeId },
    allowedCapabilities: ["brain.entity", "brain.recall", "language.generate", "brain.remember"],
    invokeCapability: async (capability, raw) => {
      const value = raw as any;
      if (capability === "brain.entity") {
        const markdown = saved.get(value.name);
        return markdown ? { found: true, status: "found", page: { slug: value.name, type: value.name.split("/")[0] === "meetings" ? "meeting" : value.name.split("/")[0] === "people" ? "person" : "source",
          markdown, content_hash: "d".repeat(64) }, indexed_revision: revision }
          : { found: false, status: "not_found", candidates: [], indexed_revision: revision };
      }
      if (capability === "brain.recall") return { hits: [], status: "ok", indexed_revision: revision };
      if (capability === "language.generate") {
        assert.deepEqual(value.data.participant_resolution, [{ name: "Alex", status: "not_found", slug: null }]);
        modelCalls++; return { text: modelText };
      }
      if (capability === "brain.remember") {
        writeCalls++;
        for (const page of value.changes.pages) saved.set(page.path.slice(6, -3), page.markdown);
        return { status: "saved", sync_status: "indexed", saved_commit: "e".repeat(40), indexed_revision: revision,
          changed_paths: value.changes.pages.map((page: any) => page.path) };
      }
      throw Error("Unexpected capability");
    } }) as Promise<any>;
  const output = await run(JSON.stringify(proposal));
  assert.equal(output.route, "one-shot"); assert.equal(modelCalls, 1); assert.equal(writeCalls, 1);
  assert.equal(output.outcome.pages.length, 3);
  assert.match(saved.get(meetingSlug)!, /date: 2030-01-01/);
  assert.match(saved.get(meetingSlug)!, /created: 2030-01-02/);
  assert.match(saved.get(meetingSlug)!, /> Alex discussed a first design goal\./);
  assert.doesNotMatch(saved.get(meetingSlug)!, /An invented quote/);
  assert.match(output.outcome.gaps.at(-1), /Removed 1 proposed non-verbatim blockquote/);
  assert.match(saved.get(personSlug)!, /tags: \[person\]/);
  saved.clear();
  const repairable = structuredClone(proposal);
  repairable.pages[1].markdown = repairable.pages[1].markdown.replaceAll("[[" + sourceSlug + "|original]]", "");
  delete (repairable.verification[4] as any).detail;
  const repaired = await run(JSON.stringify(repairable));
  assert.equal(repaired.route, "one-shot"); assert.equal(writeCalls, 2);
  assert.match(saved.get(personSlug)!, /Source: \[\[sources\/import-example\]\]/);
  assert.match(saved.get(personSlug)!.split("<!-- timeline -->")[1], /\[\[sources\/import-example\]\]/);
  assert.match(repaired.outcome.gaps.at(-1), /model omitted 1 verification explanation/);
  await assert.rejects(run(JSON.stringify({ ...proposal, source_version: "wrong" })), /source identity or page coverage/);
  assert.equal(writeCalls, 2, "Invalid paid model output cannot write or silently start an Agent fallback");
  saved.clear();
  task.original_text = task.original_text.padEnd(120_000, " ");
  const longSource = await run(JSON.stringify(proposal));
  assert.equal(longSource.route, "one-shot"); assert.equal(modelCalls, 4, "A bounded long source still uses one synthesis call");
  const literalControl = JSON.stringify(proposal).replace("\\n\\n## Summary", "\n\n## Summary");
  assert.notEqual(literalControl, JSON.stringify(proposal));
  const recovered = await run(literalControl);
  assert.equal(recovered.route, "one-shot"); assert.equal(modelCalls, 5);
  assert.ok(recovered.outcome.gaps.some((gap: string) => /Escaped 2 literal JSON control character/.test(gap)));
  assert.equal(saved.get(meetingSlug)!.includes("## Summary\nAlex discussed"), true, "Decoded Markdown remains unchanged");
  task.original_text = task.original_text.padEnd(130_001, " ");
  const tooLong = await run(JSON.stringify(proposal));
  assert.equal(tooLong.route, "agent"); assert.equal(modelCalls, 5, "An oversized source falls back before a paid call");
  task.original_text = "Alex discussed a first design goal. No decision or action was recorded.";
  task.source.context.participants = Array.from({ length: 9 }, (_, index) => "Person " + index);
  const oversized = await run(JSON.stringify(proposal));
  assert.equal(oversized.route, "agent"); assert.equal(modelCalls, 5, "Unbounded participants cannot trigger a paid one-shot call");
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
 const meetingText='## Summary\nA sourced meeting. [['+source+']] [['+person+']]\n## Key Decisions\nDiscussion only.\n## Action Items\nNo commitments.\n## Notable Quotes\nNo notable quotes.';
 const entity='A participant.\n<!-- timeline -->\n- Meeting [['+meeting+']] [['+source+']]';
 const pages=[{path:'brain/'+source+'.md',markdown:evidence},{path:'brain/'+meeting+'.md',markdown:meetingText},{path:'brain/'+person+'.md',markdown:entity}];
 const task={source:{identity:'source:1',version:'v1',kind:'meeting',context:{companyos_record_version:'a'.repeat(64)}},evidence:{slug:source},prior:{requests:[]}};
 const facts={source_identity:'source:1',source_version:'v1',status:'ingested',pages:[source,meeting,person],meetings:[{slug:meeting,attendees:[person],entities:[]}],
  verification:['V1','V2','V3','V4','V5','V6'].map(check=>({check,status:'passed',detail:'Synthetic check evidence.'})),gaps:[]};
 const calls:any[]=[{name:'oregano_brain_remember',input:{provenance:{source_id:'source:1',source_version:'v1'},changes:{pages}},output:{status:'saved',saved_commit:'b'.repeat(40),sync_status:'indexed',changed_paths:pages.map(page=>page.path)}},
  ...pages.map(page=>({name:'oregano_brain_entity',output:{status:'found',found:true,page:{slug:page.path.slice(6,-3),markdown:page.markdown},indexed_revision:{git_commit:'b'.repeat(40)}}}))];
 const check=async(value:any)=>executeIsolatedCompanyTool({compiledSource:tool.compiledSource,input:value,context:{instanceId:'synthetic',runId:'workflow:test',stepId:'process',agentId:'analyst',toolId:tool.contract.runtimeId},allowedCapabilities:[],invokeCapability:async()=>{throw Error('Pure validation cannot call a provider');}}) as Promise<any>;
 assert.equal((await check({context:{task,calls},facts})).accepted,true);
 const displayNames={...facts,meetings:[{...facts.meetings[0],attendees:['Alex Example']}]};
 const displayNameFeedback=await check({context:{task,calls},facts:displayNames});
 assert.equal(displayNameFeedback.accepted,false);
 assert.match(displayNameFeedback.feedback,/canonical Brain page slugs.*page.slug.*never display names/);
 assert.doesNotMatch(displayNameFeedback.feedback,/Read every affected page/);
 assert.match((await check({context:{task,calls:calls.slice(0,-1)},facts})).feedback,/Read every/);
 const stale=[calls[1],calls[0],...calls.slice(2)];assert.equal((await check({context:{task,calls:stale},facts})).accepted,false);
 // A later write to another page does not invalidate a verified read of this page.
 const incremental=pages.flatMap((page,i)=>[{...calls[0],input:{...calls[0].input,changes:{pages:[page]}},output:{...calls[0].output,changed_paths:[page.path]}},calls[i+1]]);
 assert.equal((await check({context:{task,calls:incremental},facts})).accepted,true);
 const missingSections=structuredClone(calls);missingSections[0].input.changes.pages[1].markdown='Bare meeting';missingSections[2].output.page.markdown='Bare meeting';
 assert.match((await check({context:{task,calls:missingSections},facts})).feedback,/V1/);
 const skipped={...facts,status:'skipped',pages:[],meetings:[],gaps:['No substantive content to file.'],verification:facts.verification.map(v=>({...v,status:'not-applicable'}))};
 assert.equal((await check({context:{task,calls:[]},facts:skipped})).accepted,true);
 for(const value of [{context:{task,calls},facts:skipped},{context:{task:{...task,prior:{requests:[{slug:person}]}},calls:[]},facts:skipped},
   {context:{task,calls:[]},facts:{...skipped,gaps:[]}}, {context:{task,calls:[{name:'oregano_brain_remember',error:'uncertain'}]},facts:skipped}])
   assert.equal((await check(value)).accepted,false);
 const partial=await check({context:{task,calls:[calls[0]]},facts});
 for(const slug of [source,meeting,person])assert.ok(partial.feedback.includes(slug),'One response lists every missing read');
 const manyMissing=await check({context:{task:{...task,prior:{requests:Array.from({length:80},(_,i)=>({slug:'people/'+String(i)+'-'+'x'.repeat(60)}))}},calls},facts});
 assert.ok(manyMissing.feedback.length<=2000);assert.match(manyMissing.feedback,/Additional repairs remain/);
 const dangling=structuredClone(calls);dangling[2].output.outgoing=[{target:'sources/mistyped',resolved:null}];
 assert.match((await check({context:{task,calls:dangling},facts})).feedback,/Repair unresolved.*sources\/mistyped/);
 const fixed=structuredClone(dangling);fixed[2].output.outgoing[0].resolved=source;
 assert.equal((await check({context:{task,calls:fixed},facts})).accepted,true);
 const referencedMeeting='meetings/earlier';
 const linked=structuredClone(calls);linked[0].input.changes.pages[1].markdown+='\n[['+referencedMeeting+']]';linked[2].output.page.markdown=linked[0].input.changes.pages[1].markdown;
 linked.push({name:'oregano_brain_entity',output:{found:true,status:'found',indexed_revision:"current",page:{slug:referencedMeeting,type:'meeting',markdown:'## Summary\nAn earlier meeting; no entity Timeline section.'}}});
 const linkedFacts={...facts,pages:[...facts.pages,referencedMeeting],meetings:[{...facts.meetings[0],entities:[referencedMeeting]}]};
 assert.equal((await check({context:{task,calls:linked},facts:linkedFacts})).accepted,true,'Meeting cross-references do not require person/company Timeline structure');
 const narrow=structuredClone(calls);
 narrow[0].input.changes.pages[2]={path:pages[2].path,expected_content_hash:'c'.repeat(64),timeline_add:{date:'2026-09-15',summary:'Meeting',evidence:[source]}};
 narrow[0].output.page_results=pages.map(page=>({path:page.path,content_hash:sha256(page.markdown)}));
 for(const read of narrow.slice(1))read.output.page.content_hash=sha256(read.output.page.markdown);
 assert.equal((await check({context:{task,calls:narrow},facts})).accepted,true,'Narrow mutations verify the actual receipt digest and subsequent read');
 const noReceipt=structuredClone(narrow);delete noReceipt[0].output.page_results;
 assert.match((await check({context:{task,calls:noReceipt},facts})).feedback,/differs/,'A request alone cannot prove a narrow mutation');
 const changedAfterSave=structuredClone(narrow);changedAfterSave.at(-1).output.page.content_hash='e'.repeat(64);
 assert.match((await check({context:{task,calls:changedAfterSave},facts})).feedback,/differs/);
 const noChange=structuredClone(narrow);noChange[0].output.status='unchanged';noChange[0].output.saved_commit=null;noChange[0].output.changed_paths=[];
 assert.equal((await check({context:{task,calls:noChange},facts})).accepted,true,'Unchanged targets still have read-back proof');
 noChange.pop();assert.match((await check({context:{task,calls:noChange},facts})).feedback,/Read every/);
 const premature={...facts,verification:facts.verification.slice(1)};assert.match((await check({context:{task,calls},facts:premature})).feedback,/V1–V6/);
 const mismatch=structuredClone(calls);mismatch.at(-1).output.page.markdown='Unrelated current content';assert.match((await check({context:{task,calls:mismatch},facts})).feedback,/differs/);
});

test("source history accepts only its exact unwritten predecessor link and never ignores another cancelled source", async () => {
  const result = materializeBrainWorkflow(input), tool = loadCompanyTool(result.materials, "analyst", "brain-source-history");
  const prior = { id: "workflow:prior", workflow_id: "brain-import", fields: { source_identity: "synthetic-source", source_version: "v1" },
    status: "cancelled", source_restart: { successorRunId: "workflow:child" }, steps: {} };
  const run = (item: any, version = "v1") => executeIsolatedCompanyTool({ compiledSource: tool.compiledSource,
    input: { workflow_id: "brain-import", history_from: "2030-01-01T00:00:00.000Z", cutoff: "2030-01-02T00:00:00.000Z", identity: "synthetic-source", version },
    context: { instanceId: "synthetic", runId: "workflow:child", stepId: "history", agentId: "analyst", toolId: tool.contract.runtimeId },
    allowedCapabilities: ["evidence.query"], invokeCapability: async () => ({ coverage: { complete: true }, items: Array.isArray(item) ? item : [item] }) });
  const output = await run(prior) as any;
  assert.deepEqual(output.prior_runs, [prior.id]); assert.deepEqual(output.requests, []);
  const archived = { ...prior, artifact_hash: "old-artifact", source_restart: { successorRunId: "workflow:previous-successor", artifactHash: "replacement-artifact" } };
  const successor = { id: "workflow:previous-successor", workflow_id: prior.workflow_id, fields: prior.fields,
    artifact_hash: "replacement-artifact", source_predecessor: { runId: prior.id, artifactHash: "old-artifact" }, status: "done",
    steps: { "finish-import": { status: "succeeded", output: { source_identity: "synthetic-source", source_version: "v1", status: "ingested", pages: [{ slug: "meetings/previous" }], receipts: [{}] } } } };
  const correction = await run([archived, successor], "v2") as any;
  assert.deepEqual(correction.prior_runs, [prior.id, successor.id]); assert.deepEqual(correction.requests, [{ key: "prior-0", slug: "meetings/previous" }]);
  await assert.rejects(run([archived, { ...successor, source_predecessor: { runId: "workflow:unrelated", artifactHash: "old-artifact" } }], "v2"));
  for (const changed of [{ ...prior, source_restart: undefined }, { ...prior, source_restart: { successorRunId: "workflow:other" } },
    { ...prior, status: "done" }, { ...prior, fields: { ...prior.fields, source_version: "v0" } }]) await assert.rejects(run(changed));
});

test("applicable adopted procedures are delivered as instructions and a no-write notability skip retains its reason", async () => {
 const result=materializeBrainWorkflow(input), config=YAML.parse(result.materials['workflows/brain-import/config.yaml']!);
 assert.equal(config.agent.instructions.length,1);assert.equal(config.agent.skills.length,7);
 const delivered=[...config.agent.instructions,...config.ingestion.routes.meeting].map((path:string)=>result.materials[path]).join('\n');
 for(const text of ['V1 — Required sections','V4 — Every quote','## Key Decisions','Before writing anything'])assert.ok(delivered.includes(text));
 const tool=loadCompanyTool(result.materials,'analyst','brain-agent-outcome');
 const task={source:{identity:'source:1',version:'v1'},prior:{requests:[]}};
 const resultFacts={status:'skipped',source_identity:'source:1',source_version:'v1',pages:[],meetings:[],verification:[],gaps:['Insufficient content for a substantive page.']};
 const run=(value:any)=>executeIsolatedCompanyTool({compiledSource:tool.compiledSource,input:value,context:{instanceId:'synthetic',runId:'workflow:test',stepId:'finish',agentId:'analyst',toolId:tool.contract.runtimeId},allowedCapabilities:[],invokeCapability:async()=>{throw Error('No provider');}}) as Promise<any>;
 const outcome=await run({task,route:'reasoning',execution:{result:resultFacts,calls:[]}});
 assert.equal(outcome.status,'skipped');assert.deepEqual(outcome.receipts,[]);assert.deepEqual(outcome.gaps,resultFacts.gaps);
 await assert.rejects(run({task:{...task,prior:{requests:[{slug:'meetings/old'}]}},route:'reasoning',execution:{result:resultFacts,calls:[]}}));
});


test("one import Workflow routes heterogeneous source projections without widening access", async () => {
  const configured = { ...input, source_routes: [{ identity_prefix: "discussion:studio:", projection: "studio-discussions" }] };
  const result = materializeBrainWorkflow(configured), workflow = workspaceDocument(result.materials, "workflows/brain-import.md").data;
  const config = YAML.parse(result.materials["workflows/brain-import/config.yaml"]);
  assert.deepEqual(config.source_routes, configured.source_routes);
  const tool = loadCompanyTool(result.materials, "analyst", "brain-source-records");
  const select = (identity: string, routes = config.source_routes) => executeIsolatedCompanyTool({ compiledSource: tool.compiledSource,
    input: { identity, version: "v1", default_projection: config.source_projection, routes }, context: { instanceId: "synthetic", runId: "routing", stepId: "projection", agentId: "analyst", toolId: tool.contract.runtimeId },
    allowedCapabilities: ["records.query"], invokeCapability: async (capability, query: any) => {
      assert.equal(capability, "records.query"); assert.deepEqual(query.filters, { identity, version: "v1" }); assert.equal(query.all_pages, true); return { rows: [], access_decision: { allowed: true } };
    } });
  assert.deepEqual(await select("discussion:studio:thread-1"), { projection_id: "studio-discussions", records: { rows: [], access_decision: { allowed: true } } });
  assert.deepEqual(await select("meeting:session-1"), { projection_id: "studio-sources", records: { rows: [], access_decision: { allowed: true } } });
  assert.deepEqual(await select("discussion:studio:thread-1", []), { projection_id: "studio-sources", records: { rows: [], access_decision: { allowed: true } } });
  const overlap = [...config.source_routes, { identity_prefix: "discussion:", projection: "other" }];
  await assert.rejects(select("meeting:session-1", overlap), /overlap/);
  for (const source_routes of [overlap, [{ identity_prefix: "", projection: "other" }], [{ identity_prefix: "discussion:", projection: "../other" }]])
    assert.throws(() => materializeBrainWorkflow({ ...input, source_routes }), /source projection/);
  assert.equal(workflow.steps[1].input.records, "$steps.source-record.records");
  const agent = workflow.steps.find((step: any) => step["process-source"] === "agent");
  assert.equal(agent.tools.find((entry: any) => entry.tool === "oregano:records/query").bind.projection_id, "$steps.source-record.projection_id");
});

test("triage score boundaries preserve low-value skips and meaningful short content without writes", async () => {
  const result = materializeBrainWorkflow({ ...input, triage: { ...input.triage,
    skip_scores_below: 3, deep_business_at_least: 7, deep_emotional_at_least: 5 } });
  const config = YAML.parse(result.materials["workflows/brain-import/config.yaml"]!);
  const execute = (name: string, value: unknown) => {
    const tool = loadCompanyTool(result.materials, "analyst", name);
    return executeIsolatedCompanyTool({ compiledSource: tool.compiledSource, input: value,
      context: { instanceId: "synthetic", runId: "triage-boundary", stepId: name, agentId: "analyst", toolId: tool.contract.runtimeId },
      allowedCapabilities: [], invokeCapability: async () => { throw Error("Qualification must never dispatch provider writes"); } }) as Promise<any>;
  };
  const base = { filing: "low_value", user_writing_present: false, user_writing_quality: 0,
    emotional_significance: 2, business_significance: 1, era: "unknown", one_line_summary: "Only recording-control chatter, with no supported event or commitment." };
  for (const [classification, route] of [
    [base, "skip"], [{ ...base, emotional_significance: 3 }, "reasoning"],
    [{ ...base, filing: "business", business_significance: 7, one_line_summary: "One explicit launch approval with a deadline." }, "deep"],
  ] as const) {
    const gate = await execute("brain-value-gate", { source_complete: true, expected_segments: ["part-1"], settings: config.triage,
      results: [{ key: "part-1", output: { text: JSON.stringify(classification) } }] });
    assert.equal(gate.route, route); assert.deepEqual(gate.items[0].classification, classification);
    if (route === "skip") {
      const task = { source: { identity: "synthetic:fragment", version: "v1" }, prior: { requests: [] } };
      const outcome = await execute("brain-agent-outcome", { task, route, execution: null });
      assert.equal(outcome.status, "skipped"); assert.deepEqual(outcome.pages, []); assert.deepEqual(outcome.receipts, []);
      assert.equal(outcome.source_version, "v1");
      await assert.rejects(execute("brain-agent-outcome", { task, route, execution: { result: {} } }));
      await assert.rejects(execute("brain-agent-outcome", { task: { ...task, prior: { requests: [{ slug: "sessions/prior" }] } }, route, execution: null }));
    }
  }
});
