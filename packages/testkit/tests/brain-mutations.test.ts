import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { BRAIN_WRITE_CAPABILITIES } from "../../brain/tools.ts";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { BrainError } from "../../brain/contracts.ts";
import { parseBrainPage } from "../../brain/documents.ts";
import { prepareBrainRemember, prepareBrainForget, type BrainRememberInput, type BrainForgetInput } from "../../brain/mutations.ts";
import { brainConfig, brainFiles, brainFixturePage as page } from "../fixtures/brain.ts";

const revision = "a".repeat(40), path = "brain/topics/expansion.md";
const provenance = { source_id: "review:1", source_version: "v1", action: "subject-update", evidence: ["sources/review"] };
const remember = (markdown: string, selected = path): BrainRememberInput => ({
  changes: { expected_revision: revision, pages: [{ path: selected, expected_content_hash: sha256(brainFiles[selected as keyof typeof brainFiles]), markdown }] },
  provenance, operation_key: "review:1:v1:subject-update",
});
const forget = (kind: "page" | "passage" | "take" = "page"): BrainForgetInput => ({
  target: { expected_revision: revision, path, expected_content_hash: sha256(brainFiles[path]), kind },
  reason: "Withdraw unsupported material after source review.", operation_key: "review:1:v1:withdrawal",
});
const code = (expected: string) => (error: unknown) => error instanceof BrainError && error.code === expected;

test("remember validates a complete atomic source and subject batch without touching its input", () => {
  const before = structuredClone(brainFiles);
  const input: BrainRememberInput = { changes: { expected_revision: revision, pages: [
    { path: "brain/sources/follow-up.md", expected_content_hash: null, markdown: page("source", "Follow-up", "[Original](https://example.org/reviews/2)") },
    { path: "brain/topics/follow-up.md", expected_content_hash: null, markdown: page("topic", "Follow-up", "A bounded proposal.\n\n<!-- timeline -->\n\n- Follow-up reviewed. [[sources/follow-up]]") },
  ] }, provenance: { ...provenance, evidence: ["sources/follow-up"] }, operation_key: "review:2:v1:subject-update" };
  const result = prepareBrainRemember(before, brainConfig, input);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(before, brainFiles);
  assert.equal(result.files["handbook/private.md"], brainFiles["handbook/private.md"]);
  assert.ok(result.changes.every(change => change.path.startsWith("brain/")));
  assert.equal(result.diagnostics.filter(item => item.severity === "error").length, 0);
});

test("remember requires source provenance, source chains and a valid complete resulting page", () => {
  const input = remember(brainFiles[path]);
  assert.equal(prepareBrainRemember(brainFiles, brainConfig, input).changes.length, 0);
  for (const evidence of [[], ["sources/missing"], ["people/alex"]]) {
    assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, { ...input, provenance: { ...provenance, evidence } }));
  }
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, remember(brainFiles[path].replaceAll("[[sources/review]]", "[[sources/missing]]"))), code("invalid_batch"));
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, remember("No frontmatter")), code("invalid_batch"));
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, { ...input, provenance: { ...provenance, source_version: "" } }), code("invalid_input"));
});

test("page preconditions preserve concurrent changes and never rebase a stale replacement blindly", () => {
  const proposed = remember(brainFiles[path].replace("No shared decision yet.", "A review is pending."));
  const concurrent = { ...brainFiles, [path]: brainFiles[path].replace("No shared decision yet.", "Another reviewer has added evidence.") };
  assert.throws(() => prepareBrainRemember(concurrent, brainConfig, proposed), code("write_conflict"));
  const unrelated = { ...brainFiles, "brain/people/sam.md": page("person", "Sam Example", "Updated unrelated background.") };
  const result = prepareBrainRemember(unrelated, brainConfig, proposed);
  assert.equal(result.files["brain/people/sam.md"], unrelated["brain/people/sam.md"]);
  assert.equal(result.changes.length, 1);
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, { ...proposed, changes: { ...proposed.changes,
    pages: [{ path, markdown: proposed.changes.pages[0].markdown!, expected_content_hash: null }] } }), code("write_conflict"));
});

test("writes reject path escapes, instruction/configuration paths and oversized batches before publication", () => {
  for (const forbidden of ["company.md", "brain/../company.md", "brain/AGENTS.md", "brain/x/SKILL.md", "brain/config.md", "brain/.hidden.md", "brain/topics/code.ts"]) {
    const input = remember(brainFiles[path]); input.changes.pages[0].path = forbidden;
    assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, input), code("invalid_path"));
  }
  const input = remember(brainFiles[path]);
  input.changes.pages = Array.from({ length: 17 }, (_, i) => ({ path: `brain/topics/p-${i}.md`, expected_content_hash: null, markdown: page("topic", "Bounded", "Context") }));
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, input), code("invalid_input"));
  input.changes.pages = Array.from({ length: 8 }, (_, i) => ({ path: `brain/topics/p-${i}.md`, expected_content_hash: null, markdown: page("topic", "Bounded", "x".repeat(55_000)) }));
  assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, input), code("write_bound"));
});

test("Take supersession retains old row identity and distinct holders while appending above the high watermark", () => {
  const source = brainFiles[path];
  const replacement = source.replace("| 4 | Delay the branch |", "| 4 | ~~Delay the branch~~ |")
    .replace("<!--- gbrain:takes:end -->", "| 8 | Reconsider after review | take | people/alex | 0.75 | 2026-09 | [[sources/review]] |\n<!--- gbrain:takes:end -->");
  const result = prepareBrainRemember(brainFiles, brainConfig, remember(replacement));
  const parsed = parseBrainPage(path, result.files[path], brainConfig).page!;
  assert.deepEqual(parsed.takes.map(take => [take.row_num, take.active]), [[1, false], [4, false], [7, true], [8, true]]);
  assert.equal(parsed.takes[2].holder, "people/sam");
  for (const invalid of [source.replace("~~Open the branch now~~", "Open the branch now"), source.replace("Delay the branch", "A different claim"),
    source.replace("| 4 |", "| 5 |"), source.replace("| people/alex | 0.73", "| people/sam | 0.73"), replacement.replace("| 8 |", "| 5 |")]) {
    assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, remember(invalid)), code("take_identity_conflict"));
  }
  assert.doesNotThrow(() => prepareBrainRemember(brainFiles, brainConfig, remember(source.replace("| 0.73 |", "| 0.85 |"))));
});

test("forget withdraws a Take and its selected current assertion together without removing other holders", () => {
  const files = { ...brainFiles, [path]: brainFiles[path].replace("No shared decision yet.", "Delay the branch") };
  const input = forget("take"); input.target.row_num = 4; input.target.expected_content_hash = sha256(files[path]);
  assert.throws(() => prepareBrainForget(files, brainConfig, input), code("dependent_assertion_remaining"));
  input.target.related_passages = [{ path, expected_content_hash: sha256(files[path]), text: "Delay the branch" }];
  const result = prepareBrainForget(files, brainConfig, input);
  const parsed = parseBrainPage(path, result.files[path], brainConfig).page!;
  assert.equal(parsed.takes.find(take => take.row_num === 4)?.active, false);
  assert.equal(parsed.takes.find(take => take.row_num === 7)?.active, true);
  assert.ok(!parsed.search_text.includes("Delay the branch"));
  assert.ok(parsed.markdown.includes("~~Delay the branch~~"), "Withdrawal preserves citation history, not complete privacy erasure");
  assert.equal(files[path].includes("~~Delay the branch~~"), false);
});

test("exact prose withdrawal rejects ambiguity, overlapping matches and attempts to modify frontmatter or Takes", () => {
  const input = forget("passage"); input.target.text = "No shared decision yet.";
  const result = prepareBrainForget(brainFiles, brainConfig, input);
  const parsed = parseBrainPage(path, result.files[path], brainConfig).page!;
  assert.ok(!parsed.compiled_truth.includes(input.target.text)); assert.equal(parsed.takes.length, 3);
  for (const text of ["Delay the branch", "type: topic", "missing passage"]) {
    assert.throws(() => prepareBrainForget(brainFiles, brainConfig, { ...input, target: { ...input.target, text } }), code("ambiguous_target"));
  }
  const duplicate = { ...brainFiles, [path]: brainFiles[path].replace("No shared decision yet.", "aaaa") };
  assert.throws(() => prepareBrainForget(duplicate, brainConfig, { ...input, target: { ...input.target, text: "aaa", expected_content_hash: sha256(duplicate[path]) } }), code("ambiguous_target"));
  assert.throws(() => prepareBrainForget(duplicate, brainConfig, input), code("write_conflict"));
});

test("page withdrawal is explicit and cannot leave invalid evidence dependencies", () => {
  const result = prepareBrainForget(brainFiles, brainConfig, forget());
  assert.deepEqual(result.changes, [{ path, markdown: null }]);
  assert.equal(Object.hasOwn(result.files, path), false);
  const input = forget(); input.target.path = "brain/sources/review.md"; input.target.expected_content_hash = sha256(brainFiles[input.target.path as keyof typeof brainFiles]);
  assert.throws(() => prepareBrainForget(brainFiles, brainConfig, input), code("invalid_batch"));
  assert.equal(Object.hasOwn(brainFiles, path), true);
});

test("Timeline-only edits preserve raw metadata, current knowledge, Takes and existing history", () => {
  const source = brainFiles[path].replace('title:', '# Preserve this comment\ntitle:').replaceAll('\n', '\r\n');
  const files = { ...brainFiles, [path]: source };
  const input: BrainRememberInput = { changes: { expected_revision: revision, pages: [{ path, expected_content_hash: sha256(source),
    timeline_add: { date: '2026-09-15', summary: 'Reviewed the proposal.', detail: 'No shared decision was made.', evidence: ['sources/review'] } }] }, provenance, operation_key: 'timeline:1' };
  assert.deepEqual(validateJsonSchemaValue(BRAIN_WRITE_CAPABILITIES[0].inputSchema, input), []);
  const result = prepareBrainRemember(files, brainConfig, input), saved = result.files[path];
  const marker = '<!-- timeline -->';
  assert.equal(saved.slice(0, saved.indexOf(marker)), source.slice(0, source.indexOf(marker)));
  const entry = '- 2026-09-15: Reviewed the proposal. — No shared decision was made. [[sources/review]]\r\n';
  assert.equal(saved.replace(entry, ''), source);
  assert.deepEqual(parseBrainPage(path, saved, brainConfig).page!.takes, parseBrainPage(path, source, brainConfig).page!.takes);
  const again = structuredClone(input); again.operation_key = 'timeline:2'; again.changes.pages[0].expected_content_hash = sha256(saved);
  assert.equal(prepareBrainRemember(result.files, brainConfig, again).changes.length, 0);
  assert.throws(() => prepareBrainRemember(result.files, brainConfig, input), code('write_conflict'));
  const mixed=source.replace('\r\n', '\n'); const mixedInput=structuredClone(input); mixedInput.changes.pages[0].expected_content_hash=sha256(mixed);
  assert.equal(prepareBrainRemember({...files,[path]:mixed},brainConfig,mixedInput).files[path].replace(entry,''),mixed);
});

test("Timeline additions normalize legacy delimiters and preserve unrelated later sections", () => {
  const bodies = [
    'Current account.\n\n---\n\nA normal horizontal rule.',
    'Current account.\n\n--- timeline ---\n\n- 2026-09-14: Earlier event. [[sources/review]]',
    'Current account.\n\n---\n## History\n- 2026-09-14: Earlier event. [[sources/review]]',
    'Current account.\n\n## History\n- 2026-09-14: Earlier event. [[sources/review]]\n\n## Unrelated\nKeep this prose as current knowledge.',
  ];
  for (const body of bodies) {
    const original = page('topic', 'Example', body), files = { ...brainFiles, [path]: original };
    const input: BrainRememberInput = { changes: { expected_revision: revision, pages: [{ path, expected_content_hash: sha256(original),
      timeline_add: { date: '2026-09-15', summary: 'New event.', evidence: ['sources/review'] } }] }, provenance, operation_key: 'timeline:legacy' };
    const saved = prepareBrainRemember(files, brainConfig, input).files[path], parsed = parseBrainPage(path, saved, brainConfig).page!;
    assert.ok(saved.includes('<!-- timeline -->')); assert.ok(parsed.compiled_truth.includes('Current account.'));
    if (body.includes('Unrelated')) assert.ok(parsed.compiled_truth.includes('Keep this prose as current knowledge.'));
    if (body.includes('Earlier')) assert.ok(parsed.timeline.indexOf('2026-09-15') < parsed.timeline.indexOf('2026-09-14'));
    if (body.includes('horizontal')) assert.ok(parsed.compiled_truth.includes('---\n\nA normal horizontal rule.'));
  }
});

test("Timeline additions reject malformed events, undeclared evidence and absent targets before saving", () => {
  const timeline_add = { date: '2026-09-15', summary: 'Review occurred.', evidence: ['sources/review'] };
  const input: BrainRememberInput = { changes: { expected_revision: revision, pages: [{ path, expected_content_hash: sha256(brainFiles[path]), timeline_add }] }, provenance, operation_key: 'timeline:invalid' };
  for (const patch of [{ date: '2026-02-30' }, { date: 'yesterday' }, { summary: 'Fake\n<!-- timeline -->' }, { detail: '\nInjected block' },
    { evidence: [] }, { evidence: ['sources/review', 'sources/review'] }, { evidence: ['../AGENTS'] }, { evidence: ['sources/missing'] }, { evidence: ['people/alex'] }]) {
    const invalid = structuredClone(input); Object.assign(invalid.changes.pages[0].timeline_add!, patch);
    assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, invalid));
  }
  for (const patch of [{ expected_content_hash: null }, { markdown: brainFiles[path] }]) {
    const invalid = structuredClone(input); Object.assign(invalid.changes.pages[0], patch);
    assert.throws(() => prepareBrainRemember(brainFiles, brainConfig, invalid), code('invalid_input'));
  }
  const added = prepareBrainRemember(brainFiles, brainConfig, input);
  const replacement = added.files[path].replace('2026-09-15: Review occurred.', '2026-09-14: Review occurred (date corrected from the source).');
  const correction = remember(replacement); correction.changes.pages[0].expected_content_hash = sha256(added.files[path]); correction.provenance.source_version = 'v2';
  const saved = prepareBrainRemember(added.files, brainConfig, correction).files[path];
  assert.ok(saved.includes('date corrected')); assert.ok(!saved.includes('2026-09-15: Review occurred.'));
  assert.deepEqual(parseBrainPage(path, saved, brainConfig).page!.takes, parseBrainPage(path, brainFiles[path], brainConfig).page!.takes);
});
