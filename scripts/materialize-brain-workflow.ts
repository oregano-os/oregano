import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import YAML from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { sha256 } from "../packages/runtime/canonical.ts";
import { validateTranscriptSelectionPolicy, type TranscriptSelectionPolicy } from "../packages/brain/import-policy.ts";
import { materializeBrainPrompts, type BrainPromptInputs } from "./materialize-brain-prompts.ts";
import { MAX_INSTRUCTION_CHARACTERS } from "../packages/language/prompt-binding.ts";

const blueprintRoot = fileURLToPath(new URL("../packages/blueprints/brain/", import.meta.url));
const toolRoot = fileURLToPath(new URL("../packages/cli/content/templates/brain-import/", import.meta.url));
const workflowPath = "workflows/brain-import.md";
const phaseNames = { normalization: "meeting-normalize", resolution: "meeting-resolve", meeting_page: "meeting-page", entity_page: "meeting-entities", verification: "meeting-verify", discussion_extraction: "discussion-extract", discussion_entity: "discussion-entities", source_reconciliation: "source-reconcile", source_reconciliation_verification: "source-reconcile-verify" };
export interface BrainWorkflowInputs {
  prompt: BrainPromptInputs;
  source_projection: string;
  source_routes?: Array<{ identity_prefix: string; projection: string }>;
  transcripts: TranscriptSelectionPolicy;
  segment_characters: number;
  history_from: string;
  triage: { filing_categories: string[]; deep_filing: string[]; deep_quality_at_least: number; deep_emotional_at_least: number; deep_business_at_least: number; skip_filing: string[]; skip_scores_below: number };
}
function readAsset(root: string, path: string): string {
  if (path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe Brain template path");
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    if (!current.startsWith(root) || lstatSync(current).isSymbolicLink()) throw new Error("Unsafe Brain template link");
  }
  if (!lstatSync(current).isFile()) throw new Error("Brain template must be a regular file");
  return readFileSync(current, "utf8");
}
const frontmatter = (text: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Brain template lacks frontmatter");
  return { value: YAML.parse(match[1]), body: text.slice(match[0].length) };
};

/** Pure authoring helper: returns ordinary reviewed files; never writes, grants, binds or activates. */
export function materializeBrainWorkflow(input: BrainWorkflowInputs) {
  if (!input || Object.keys(input).filter(key => key !== "source_routes").sort().join(",") !== "history_from,prompt,segment_characters,source_projection,transcripts,triage") throw new Error("Invalid reviewed Brain Workflow inputs");
  const prompts = materializeBrainPrompts(input.prompt);
  const transcripts = validateTranscriptSelectionPolicy(input.transcripts);
  const history = validateTranscriptSelectionPolicy({ mode: "bounded", max_transcripts: 1, meeting_date: { start_at: input.history_from, end_at: null } }).meeting_date.start_at;
  if (!history || typeof input.source_projection !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.source_projection)) throw new Error("Explicit source projection and history start are required");
  const sourceRoutes = input.source_routes ?? [];
  if (!Array.isArray(sourceRoutes) || sourceRoutes.length > 32 || sourceRoutes.some((route, index) => !route
    || Object.keys(route).sort().join(",") !== "identity_prefix,projection"
    || typeof route.identity_prefix !== "string" || !route.identity_prefix.length || route.identity_prefix.length > 1000
    || /[\x00-\x1f\x7f]/.test(route.identity_prefix) || !/^[a-z][a-z0-9-]{0,63}$/.test(route.projection)
    || sourceRoutes.slice(0, index).some(other => route.identity_prefix.startsWith(other.identity_prefix) || other.identity_prefix.startsWith(route.identity_prefix))))
    throw new Error("Invalid or overlapping reviewed source projection routes");
  const manifest = JSON.parse(readAsset(toolRoot, "manifest.json")) as { version: number; files: { path: string; digest: string }[]; workflow_digest: string; agent_instruction_digest: string };
  if (manifest.version !== 2 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Invalid Brain template manifest");
  const assets: Record<string, string> = {};
  for (const entry of manifest.files) {
    if (!/^tools\/brain-[a-z-]+\/(?:execute\.ts|TOOL\.md)$/.test(entry.path) || Object.hasOwn(assets, entry.path)) throw new Error("Invalid or duplicate Brain Tool template");
    const text = readAsset(toolRoot, entry.path);
    if (sha256(text) !== entry.digest) throw new Error("Changed Brain Tool template; review its manifest before materialization");
    assets[entry.path] = text;
  }
  const entries = readdirSync(toolRoot, { recursive: true, withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw new Error("Brain Tool templates cannot contain links");
  const actual = entries.filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name).slice(toolRoot.length)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(["manifest.json", ...Object.keys(assets)].sort())) throw new Error("Untracked Brain Tool template content");
  const validator = new Ajv2020({ strict: false });
  const gate = frontmatter(assets["tools/brain-value-gate/TOOL.md"]).value;
  const prepare = frontmatter(assets["tools/brain-prepare-source/TOOL.md"]).value;
  if (!validator.validate(gate.input_schema.properties.settings, input.triage)
    || !validator.validate(prepare.input_schema.properties.segment_characters, input.segment_characters)
    || JSON.stringify(input.triage.filing_categories) !== JSON.stringify(input.prompt.filing_categories)
    || ![input.triage.deep_filing, input.triage.skip_filing].every(values => values.every(value => input.triage.filing_categories.includes(value)))) throw new Error("Invalid or inconsistent Workspace triage and segment policy");
  const source = readAsset(blueprintRoot, workflowPath);
  if (sha256(source) !== manifest.workflow_digest) throw new Error("Changed Brain Workflow template; review its manifest before materialization");
  const { value: workflow, body } = frontmatter(source);
  if (workflow.id !== "brain-import" || workflow.owner !== "agents/brain-owner" || workflow.trigger !== "operator") throw new Error("Unexpected Brain Workflow authority template");
  const declaredTools = [...new Set<string>(workflow.steps.flatMap((step: Record<string, unknown>) => [Object.values(step)[0], step.validate]).filter((tool: unknown) => typeof tool === "string" && tool.startsWith("company:")))].sort();
  const availableTools = Object.keys(assets).filter(path => path.endsWith("/TOOL.md")).map(path => `company:${path.split("/")[1]}`).sort();
  if (declaredTools.some(tool => !availableTools.includes(tool)) || availableTools.some(tool => !assets[`tools/${tool.slice(8)}/execute.ts`])) throw new Error("Brain Workflow and restricted Tool templates do not resolve together");
  workflow.owner = `agents/${input.prompt.agent_id}`;
  const binding = (phase: string) => {
    const path = `agents/${input.prompt.agent_id}/skills/brain-${phase}/SKILL.md`;
    if (!prompts.materials[path]) throw new Error("Workflow phase is missing its reviewed prompt");
    return path;
  };
  const taskInstructions = readAsset(blueprintRoot, "agent-instructions.md");
  if (sha256(taskInstructions) !== manifest.agent_instruction_digest) throw new Error("Changed incremental Agent instructions; review their manifest before materialization");
  const adoption = JSON.parse(readAsset(blueprintRoot, "adoption.json"));
  const section = (id: string) => {
    const entry = adoption.sections.find((entry: any) => entry.id === id);
    if (!entry) throw new Error("Missing adopted Agent Skill section");
    const text = readAsset(blueprintRoot, entry.path);
    if (sha256(text) !== entry.sha256) throw new Error("Changed adopted Agent Skill section");
    return text.replace(/\{\{([a-z_]+)\}\}/g, (_: string, key: keyof typeof input.prompt.directories) => input.prompt.directories[key]);
  };
  const groups = {
    task: [taskInstructions, `Reviewed perspective: ${input.prompt.perspective}\nDirectory mappings: ${JSON.stringify(input.prompt.directories)}`, ...["filing", "quality", "untrusted", "lookup", "model-roles"].map(section)],
    "meeting-work": ["meeting-contract", "meeting-normalize", "meeting-page"].map(section),
    "entity-work": ["meeting-entities", "enrich"].map(section),
    "verify-work": ["meeting-verify", "meeting-report"].map(section),
    "source-work": ["ingest", "extraction"].map(section),
  };
  const agentSkills = Object.fromEntries(Object.entries(groups).map(([name, sections]) => {
    const path = `agents/${input.prompt.agent_id}/skills/brain-${name}/SKILL.md`;
    const text = `---\nname: brain-${name}\ndescription: Reviewed ${name} guidance for continuing source ingestion.\n---\n\n` + sections.join("\n\n");
    if (text.length > 30000 || text.includes("{{")) throw new Error("Incremental Agent Skill exceeds its reviewed instruction bound");
    return [path, text];
  }));
  const oneShotSections = ["filing", "quality", "untrusted", "lookup", "model-roles", "meeting-contract", "meeting-page", "meeting-entities", "meeting-verify"];
  const oneShotContract = `# One-shot Brain source synthesis

Use the supplied complete source, triage, pre-retrieved existing pages and exact original-source evidence. Do not call Tools; do not claim that any page has already been written. Preserve prior sourced Timeline entries and active Takes when updating a page. Create a meeting page for a meeting source and meaningful person pages for confirmed attendees. Other company/concept pages are optional when source evidence warrants them. Never promote a company-specific claim into Core policy.

Return exactly one JSON object with keys source_identity, source_version, pages, meetings, verification, gaps. source_identity and source_version must exactly match the input. pages is an array of 1–15 objects with exactly slug and markdown. Each markdown value is a complete ordinary page with YAML frontmatter and body. Use the reviewed directory mappings. Each page needs type, title, lang and bounded tags (plain lower-case labels). The host stamps created/updated from its trusted processing instant and meeting date from source occurrence; do not invent these dates. Keep participant aliases where evidenced. Cite the supplied [[internal_evidence_page]] on every page and on each Take/Timeline entry. A meeting page must contain ## Summary, ## Key Decisions, ## Action Items, ## Notable Quotes; explicitly say when no supported decision, action or quote exists. Person/company/concept pages need <!-- timeline --> and meeting backlinks. Mark uncertainty and disagreements rather than smoothing them away.

meetings is an array of meeting summaries with slug, attendees and entities. verification is an array of V1–V6 observations with check, status and detail; these are proposed observations, not proof of saved-page verification. gaps is an array of unresolved evidence gaps. No Markdown fence or explanatory prose outside the JSON object. If coverage cannot fit, return a bounded explicit gap rather than fabricated knowledge.

Reviewed company perspective: ${input.prompt.perspective}
Directory mappings: ${JSON.stringify(input.prompt.directories)}
Filing categories: ${input.prompt.filing_categories.join(", ")}

`;
  const oneShotBase = oneShotContract + oneShotSections.map(section).join("\n\n");
  if (oneShotBase.length > MAX_INSTRUCTION_CHARACTERS || oneShotBase.includes("{{")) throw new Error("One-shot instructions exceed the reviewed bound");
  const oneShotMaterials: Record<string, string> = {}, oneShotPrompts = [];
  for (const profile of ["reasoning", "deep"] as const) {
    const path = `agents/${input.prompt.agent_id}/skills/brain-one-shot-${profile}/SKILL.md`;
    const instructions = `---\nname: brain-one-shot-${profile}\ndescription: Produce one source-scoped multi-page Brain proposal without model Tools.\n---\n\n` + oneShotBase;
    oneShotMaterials[path] = instructions;
    oneShotPrompts.push({ agent_id: input.prompt.agent_id, path, model_task: profile === "deep" ? "brain.ingest.deep" : "brain.ingest",
      model_profile: profile, max_instruction_characters: instructions.length, conversation_context: false });
  }
  const directories = input.prompt.directories;
  const config = { schema_version: 2, id: "brain-import", transcripts, triage: structuredClone(input.triage), source_projection: input.source_projection, source_routes: structuredClone(sourceRoutes), segment_characters: input.segment_characters,
    prompts: { triage: binding("triage"), one_shot: { reasoning: oneShotPrompts[0].path, deep: oneShotPrompts[1].path },
      ...Object.fromEntries(Object.entries(phaseNames).map(([key, phase]) => [key, { reasoning: binding(phase), deep: binding(`${phase}-deep`) }])) },
    page_directories: { person: directories.person_directory, company: directories.company_directory, concept: directories.concept_directory, meeting: directories.meeting_directory, source: directories.evidence_directory },
    agent: { instructions: Object.keys(agentSkills),
      skills: [], budget: { turns: 12, tool_calls: 48, output_tokens: 12000 } },
    source_history: { workflow_id: "brain-import", from: history } };
  const materials: Record<string, string> = { ...prompts.materials, ...oneShotMaterials, ...agentSkills, [workflowPath]: `---\n${YAML.stringify(workflow)}---\n${body.replaceAll("[brain-owner,", `[${input.prompt.agent_id},`)}`, "workflows/brain-import/config.yaml": YAML.stringify(config) };
  for (const [path, text] of Object.entries(assets).filter(([path]) => declaredTools.includes(`company:${path.split("/")[1]}`))) materials[`agents/${input.prompt.agent_id}/${path}`] = text;
  const tools = declaredTools;
  return { materials, prompts: [...prompts.prompts, ...oneShotPrompts], report: { version: 1, blueprint: "oregano/brain", inputs_digest: sha256(input), workflow_steps: workflow.steps.length,
    files: Object.entries(materials).map(([path, text]) => ({ path, digest: sha256(text) })), prompt_qualification: prompts.report,
    requirements: { tools: [...tools, "oregano:records/query", "oregano:brain/recall", "oregano:brain/entity", "oregano:brain/remember"], source_projection: input.source_projection },
    activated: false, grants_applied: false, provider_bindings_applied: false, admission_created: false,
    adoption: "Ordinary Workspace review, validation and inspection; explicit Instance bindings and cohort admission remain required. No install, grant, schedule or runtime activation is performed." } };
}
