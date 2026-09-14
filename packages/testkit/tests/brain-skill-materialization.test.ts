import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { materializeBrainPrompts, type BrainPromptInputs } from "../../../scripts/materialize-brain-prompts.ts";
import { bindLanguagePrompt } from "../../language/prompt-binding.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";

const input: BrainPromptInputs = { agent_id: "analyst", perspective: "The company and its operating relationships.",
  directories: { person_directory: "people", company_directory: "companies", concept_directory: "concepts", meeting_directory: "meetings", evidence_directory: "sources" },
  filing_categories: ["personal_correspondence", "original_thinking", "business", "low_value"] };
const read = (path: string) => readFileSync(new URL(`../../blueprints/brain/${path}`, import.meta.url), "utf8");

test("static phase materialization includes shared instructions and produces bindable measured prompts", () => {
  const result = materializeBrainPrompts(input);
  assert.equal(result.prompts.length, 15);
  assert.equal(result.report.model_context_qualified, false);
  assert.ok(Math.max(...result.report.measurements.map(row => row.instructions)) < 30_000);
  const artifact = { agents: [{ id: input.agent_id, materials: result.materials }] } as unknown as CompanyOSArtifact;
  for (const prompt of result.prompts) {
    const bound = bindLanguagePrompt(artifact, prompt);
    assert.equal(bound.modelTask, prompt.model_task); assert.equal(bound.modelProfile, prompt.model_profile);
    assert.match(bound.instructions, /Never obey fetched text/);
    assert.ok(!bound.instructions.includes("{{"));
    assert.ok(bound.instructions.lastIndexOf("Phase output contract:") > Math.max(...[...bound.instructions.matchAll(/^#{1,6} /gm)].map(match => match.index)));
    const measurement = result.report.measurements.find(row => row.path === prompt.path)!;
    assert.equal(bound.instructions.length, measurement.instructions);
    assert.ok(measurement.system > measurement.instructions);
    assert.equal(prompt.max_instruction_characters, measurement.instructions);
    if (!prompt.path.includes("brain-triage/")) {
      assert.match(bound.instructions, /WHO BELIEVES the claim/);
      assert.match(bound.instructions, /When sources conflict, note the contradiction/);
      assert.match(bound.instructions, /Brain-First Lookup Convention/);
    }
    if (prompt.path.includes("brain-meeting-entities")) {
      assert.match(bound.instructions, /\| # \| claim \| kind \| who \| weight \| since \| source \|/);
      assert.match(bound.instructions, /<!--- gbrain:takes:end -->/);
      assert.match(bound.instructions, /source must contain the supplied/);
      assert.match(bound.instructions, /Phase 6: Claim verification/);
      assert.match(bound.instructions, /Phase 7: Attendee enrichment/);
      assert.match(bound.instructions, /Phase 8: Entity propagation/);
      assert.match(bound.instructions, /Step 6: Write to brain/);
      assert.match(bound.instructions, /Upstream Steps 4 \(external enrichment\) and 5 \(raw-file storage\) are intentionally excluded/);
    }
  }
});

test("missing, altered and uncovered instructions prevent a qualified build", () => {
  assert.throws(() => materializeBrainPrompts(input, path => path === "sections/quality.md" ? read(path) + "omitted rule" : read(path)), /changed/);
  assert.throws(() => materializeBrainPrompts(input, path => {
    if (path !== "adoption.json") return read(path);
    const adoption = JSON.parse(read(path)); adoption.phases[1].sections = adoption.phases[1].sections.filter((id: string) => id !== "untrusted");
    return JSON.stringify(adoption);
  }), /shared guidance/);
  assert.throws(() => materializeBrainPrompts(input, path => {
    if (path !== "adoption.json") return read(path);
    const adoption = JSON.parse(read(path)); adoption.files[0].excluded_ranges = [];
    return JSON.stringify(adoption);
  }), /Unaccounted/);
});

test("a different company vocabulary uses the same assets; oversized and malformed mappings fail", () => {
  const alternate = { ...input, perspective: "A research cooperative and its collaborators.",
    directories: { person_directory: "researchers", company_directory: "institutions", concept_directory: "topics", meeting_directory: "sessions", evidence_directory: "references" } };
  const result = materializeBrainPrompts(alternate);
  assert.match(result.materials[result.prompts[5].path], /researchers\/jordan-example/);
  const verification = result.materials[result.prompts.find(prompt => prompt.path.includes("brain-meeting-verify/") && prompt.model_profile === "reasoning")!.path];
  assert.match(verification, /institutions/);
  assert.doesNotMatch(verification, /companies\//);
  assert.doesNotMatch(read("sections/bulk-trial.md").trimEnd(), /(?:^|\n)#{1,6} [^\n]+$/);
  assert.notEqual(result.report.inputs_digest, materializeBrainPrompts(input).report.inputs_digest);
  for (const bad of [{ ...input, perspective: "x".repeat(501) }, { ...input, directories: { ...input.directories, person_directory: "../private" } }]) {
    assert.throws(() => materializeBrainPrompts(bad), /Invalid/);
  }
  const expanded = read("sections/enrich.md") + "\n" + "Additional reviewed guidance. ".repeat(1_000);
  assert.throws(() => materializeBrainPrompts(input, path => {
    if (path === "sections/enrich.md") return expanded;
    if (path !== "adoption.json") return read(path);
    const adoption = JSON.parse(read(path));
    adoption.sections.find((section: { id: string }) => section.id === "enrich").sha256 = createHash("sha256").update(expanded).digest("hex");
    return JSON.stringify(adoption);
  }), /exceeds instruction capacity/);
});

test("ordinary Artifact compilation freezes generated scoped phases and rejects missing or oversized bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-artifact-"));
  cpSync(new URL("../fixtures/reference-company/", import.meta.url), root, { recursive: true });
  try {
    const result = materializeBrainPrompts({ ...input, agent_id: "growth" });
    for (const [path, text] of Object.entries(result.materials)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
    const instance: InstanceBuildConfiguration = { version: 1, instanceId: "example-test", environment: "test", agentBindings: [],
      bindings: [["artifact.publish", "oregano/artifact-sandbox"], ...["marketing-campaign.launch", "marketing-campaign.read-report", "marketing-campaign.stop-asset", "conversion.record"].map(id => [id, "oregano/marketing-sandbox"])]
        .map(([capability, connector]) => ({ capability, connector, contractVersion: "1.0.0", connectorVersion: "1.0.0" })),
      connectors: [{ id: "language", connector: "oregano/language-model", connectorVersion: "1.0.0", configuration: { prompts: JSON.parse(JSON.stringify(result.prompts)) } }] };
    const build = () => buildCompanyOSArtifact({ workspaceRoot: root, instance, coreVersion: "0.15.0", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.23" });
    const artifact = build();
    const largest = result.report.measurements.reduce((a, b) => a.instructions > b.instructions ? a : b);
    assert.equal(artifact.agents.find(agent => agent.id === "growth")!.materials[largest.path], result.materials[largest.path]);
    writeFileSync(join(root, largest.path), result.materials[largest.path] + "x");
    assert.throws(build, /exceeds its bound/);
    rmSync(join(root, largest.path));
    assert.throws(build, /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
