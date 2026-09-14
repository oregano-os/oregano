import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, link, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseBrainConfiguration } from "../../brain/configuration.ts";
import { assertBrainPath, assertBrainGitEntry } from "../../brain/paths.ts";
import { parseBrainPage, serializeBrainPage, checkBrainCorpus, resolveBrainName } from "../../brain/documents.ts";
import { parseTakes, renderTakes } from "../../brain/takes.ts";
import { readLocalBrainFiles } from "../../brain/local-files.ts";
import { splitBody } from "../../brain/upstream/timeline.ts";

import { brainConfig, brainFiles, brainFixturePage as page, brainFixtureTakes as takes } from "../fixtures/brain.ts";

test("Brain accepts only ordinary knowledge files within its path boundary", () => {
  assertBrainPath("brain/topics/payment-terms.md");
  for (const path of ["handbook/topic.md", "brain/../company.md", "/brain/a.md", "brain/a/../../b.md", "brain/a%2f..%2fb.md", "brain/a\\b.md", "brain/.git/info.md", "brain/AGENTS.md", "brain/x/SKILL.md", "brain/config.md", "brain/a.ts", "brain//a.md"]) {
    assert.throws(() => assertBrainPath(path), /knowledge Markdown/);
  }
  for (const [mode, type] of [["120000", "blob"], ["160000", "commit"], ["100755", "blob"]]) {
    assert.throws(() => assertBrainGitEntry({ path: "brain/topics/a.md", mode, type }), /regular Git/);
  }
});

test("pinned Timeline split behavior round-trips ordinary rules, decorated and legacy layouts", () => {
  for (const body of ["Current text.\n\n---\n\nStill current.", "Current text.\n\n<!--timeline-->\n\n- 2026-01-01: Evidence.",
    "Current text.\n\n--- timeline ---\n- 2026-01-01: Evidence.", "Current text.\n---\n## History\n- 2026: Event.",
    "Current text.\n## Timeline\n- 2026: Event.\n## Details\nThese remain current.", "Current text.\n## History\nOrdinary prose history."]) {
    const expected = splitBody(body);
    const parsed = parseBrainPage("brain/topics/round-trip.md", page("topic", "Round trip", body), brainConfig).page!;
    assert.equal(parsed.compiled_truth, expected.compiled_truth); assert.equal(parsed.timeline, expected.timeline);
    const second = parseBrainPage(parsed.path, serializeBrainPage(parsed.metadata, parsed.compiled_truth, parsed.timeline), brainConfig).page!;
    assert.equal(second.compiled_truth.trim(), parsed.compiled_truth.trim()); assert.equal(second.timeline.trim(), parsed.timeline.trim());
  }
  assert.equal(splitBody("Text.\n\n---\n\nMore text.").timeline, "");
  assert.equal(splitBody("Text.\n## History\nUndated ordinary prose.").timeline, "");
});

test("Takes preserve stable identity, attribution, inactive history and escaped cells", () => {
  const parsed = parseTakes(takes, "brain/topics/expansion.md", brainConfig);
  assert.deepEqual(parsed.takes.map(take => [take.row_num, take.active]), [[1, false], [4, true], [7, true]]);
  assert.equal(parsed.takes[1].weight, 0.75); assert.equal(parsed.diagnostics[0].code, "takes_weight_normalized");
  assert.ok(!parsed.prose.includes("Open the branch"));
  const escaped = parsed.takes.map(take => ({ ...take, claim: take.claim + " | detail", source: take.source + " | context" }));
  assert.deepEqual(parseTakes(renderTakes(escaped), "brain/topics/a.md", brainConfig).takes, escaped);
  for (const invalid of [takes.replaceAll("<!---", "<!--"), takes.replace("| 4 |", "| 1 |"), takes.replace("| who |", "| holder |"),
    takes.replace("| 0.73 |", "| NaN |"), takes.replace("| people/alex |", "| users/alex |"), takes.replace("| 2026-09 |", "| 2026-02-30 |"), `${takes}\n${takes}`]) {
    assert.ok(parseTakes(invalid, "brain/topics/a.md", brainConfig).diagnostics.some(item => item.severity === "error"));
  }
});

test("whole-corpus checking resolves aliases, typed edges, original evidence and excludes external files", () => {
  const corpus = checkBrainCorpus(brainFiles, brainConfig);
  assert.deepEqual(corpus.diagnostics.filter(item => item.severity === "error"), []);
  assert.equal(corpus.pages.length, 5);
  const alex = resolveBrainName(corpus.pages, "Alex")[0];
  assert.equal(alex.links[0].resolved, "companies/example"); assert.equal(alex.links[0].relation, "works_at");
  const expansion = resolveBrainName(corpus.pages, "topics/expansion")[0];
  assert.ok(!expansion.search_text.includes("Delay the branch")); assert.equal(expansion.takes.length, 3);
  const missing = checkBrainCorpus({ ...brainFiles, "brain/sources/review.md": page("source", "Missing source", "No original link.") }, brainConfig);
  assert.ok(missing.diagnostics.some(item => item.code === "original_source_missing"));
  assert.ok(missing.diagnostics.some(item => item.code === "take_evidence_missing"));
  assert.ok(missing.diagnostics.some(item => item.code === "timeline_evidence_missing"));
  const ambiguous = { ...brainFiles, "brain/people/second-alex.md": page("person", "Second Alex", "Another person.", 'aliases: [Alex]\n') };
  assert.equal(resolveBrainName(checkBrainCorpus(ambiguous, brainConfig).pages, "Alex").length, 2);
});

test("the same parser supports another vocabulary and rejects unknown declaration/page shapes", () => {
  const config = parseBrainConfiguration("version: 1\ntypes:\n  researcher: {directory: researchers, role: person}\n  reference: {directory: references, role: evidence}\n");
  const parsed = parseBrainPage("brain/researchers/alex.md", page("researcher", "Alex", "Research context."), config);
  assert.deepEqual(parsed.diagnostics, []);
  for (const bad of ["version: 2\ntypes: {}", "version: 1\ntypes: {}", "version: 1\ntypes: {topic: {directory: ../other}}", "version: 1\ntypes: {topic: {directory: topics}}\nusers: [admin]"]) assert.throws(() => parseBrainConfiguration(bad));
  for (const text of ["No frontmatter", page("unknown", "Unknown", "Text"), "---\ntype: topic\ntype: person\ntitle: Duplicate\n---\nText", "---\ntype: topic\ntitle: Test\naliases: &x [*x]\n---\nText"]) {
    assert.ok(parseBrainPage("brain/topics/test.md", text, brainConfig).diagnostics.some(item => item.severity === "error"));
  }
});

test("local input rejects links, hardlinks and executable Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "brain-files-"));
  try {
    await mkdir(join(root, "brain/topics"), { recursive: true });
    await writeFile(join(root, "source.md"), "External content");
    const target = join(root, "brain/topics/page.md");
    await symlink(join(root, "source.md"), target); await assert.rejects(readLocalBrainFiles(root)); await rm(target);
    await link(join(root, "source.md"), target); await assert.rejects(readLocalBrainFiles(root), /hardlinks/); await rm(target);
    await writeFile(target, "Ordinary text"); await chmod(target, 0o755); await assert.rejects(readLocalBrainFiles(root), /non-executable/);
    await chmod(target, 0o644); assert.deepEqual(await readLocalBrainFiles(root), { "brain/topics/page.md": "Ordinary text" });
    await rm(join(root, "brain/topics"), { recursive: true });
    await symlink(root, join(root, "brain/topics")); await assert.rejects(readLocalBrainFiles(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
