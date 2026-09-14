import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LANGUAGE_SYSTEM_PREFIX } from "../packages/language/contracts.ts";
import { MAX_INSTRUCTION_CHARACTERS, type LanguagePromptBinding } from "../packages/language/prompt-binding.ts";

const assetRoot = fileURLToPath(new URL("../packages/blueprints/brain/", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const directories = ["person_directory", "company_directory", "concept_directory", "meeting_directory", "evidence_directory"] as const;
export interface BrainPromptInputs {
  agent_id: string;
  perspective: string;
  directories: Record<typeof directories[number], string>;
  filing_categories: string[];
}
interface Section { id: string; path: string; sha256: string; source: string; ranges: [number, number][] }
interface Phase { id: string; task: string; profile: "utility" | "reasoning"; sections: string[]; output: string }
interface Adoption { version: number; upstream: { repository: string; commit: string }; sections: Section[]; phases: Phase[];
  files: { path: string; line_count: number; excluded_ranges: [number, number][]; exclusion_reason: string }[] }

function readAsset(path: string): string {
  const full = resolve(assetRoot, path);
  if (!full.startsWith(assetRoot) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe Brain asset path");
  let current = assetRoot;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Brain instruction assets must not be symlinks");
  }
  if (!lstatSync(full).isFile()) throw new Error("Brain instruction asset must be a regular file");
  return readFileSync(full, "utf8");
}

/** Static build helper, never an Agent Tool or a runtime instruction loader. */
export function materializeBrainPrompts(input: BrainPromptInputs, read = readAsset) {
  if (!input || Object.keys(input).sort().join(",") !== "agent_id,directories,filing_categories,perspective"
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.agent_id)
    || typeof input.perspective !== "string" || !input.perspective.trim() || input.perspective.length > 500
    || !input.directories || Object.keys(input.directories).sort().join(",") !== [...directories].sort().join(",")
    || directories.some(key => !/^[a-z][a-z0-9-]{0,39}$/.test(input.directories[key]))
    || !Array.isArray(input.filing_categories) || input.filing_categories.length < 1 || input.filing_categories.length > 20
    || input.filing_categories.some(value => !/^[a-z][a-z0-9_]{0,39}$/.test(value))
    || new Set(input.filing_categories).size !== input.filing_categories.length) throw new Error("Invalid reviewed Brain prompt build inputs");
  const manifestText = read("adoption.json");
  const adoption = JSON.parse(manifestText) as Adoption;
  if (adoption.version !== 1 || adoption.upstream.commit !== "a6be012a3bcfac42e279630aedec5cda4a450e29"
    || adoption.files.length !== 10 || adoption.sections.length !== 16 || adoption.phases.length !== 8) throw new Error("Unexpected pinned Brain adoption");
  const sections = new Map<string, string>();
  for (const section of adoption.sections) {
    const text = read(section.path);
    if (sections.has(section.id) || digest(text) !== section.sha256) throw new Error("Missing, duplicate or changed Brain instruction section");
    sections.set(section.id, text);
  }
  for (const file of adoption.files) {
    const included = adoption.sections.filter(section => section.source === file.path).flatMap(section => section.ranges);
    const covered = new Set<number>();
    if (file.excluded_ranges.length && !file.exclusion_reason.trim()) throw new Error("Unexplained upstream exclusion");
    for (const [start, end] of [...included, ...file.excluded_ranges]) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > file.line_count) throw new Error("Invalid upstream coverage range");
      for (let n = start; n <= end; n++) covered.add(n);
    }
    if (covered.size !== file.line_count) throw new Error("Unaccounted upstream instructions");
  }
  const common = ["filing", "quality", "untrusted", "lookup", "model-roles"];
  const materials: Record<string, string> = {}, prompts: LanguagePromptBinding[] = [];
  const measurements: { phase: string; path: string; sections: string[]; instructions: number; system: number; bytes: number; digest: string }[] = [];
  for (const phase of adoption.phases) {
    if (typeof phase.output !== "string" || !phase.output.trim() || phase.output.length > 1_000) throw new Error("Missing bounded phase output contract");
    const required = phase.id === "triage" ? ["untrusted", "model-roles", "triage"] : [...common];
    if (phase.id.startsWith("meeting-") || phase.id === "bulk-trial") required.push("meeting-contract");
    if (required.some(key => !phase.sections.includes(key)) || new Set(phase.sections).size !== phase.sections.length) throw new Error("Phase lacks required shared guidance");
    if (phase.profile !== "utility" && phase.profile !== "reasoning") throw new Error("Invalid phase model profile");
    const variants = phase.profile === "utility" ? [phase] : [phase, { ...phase, id: `${phase.id}-deep`, task: "brain.ingest.deep", profile: "deep" as const }];
    for (const variant of variants) {
      const preface = `# Reviewed Brain phase: ${phase.id}\n\nThis call prepares only this phase's bounded result. It has no Tools and cannot write, synchronize or declare completed effects. Procedure references to recall/entity/write mean use supplied authorized page context and propose the next required operation for the host workflow. If evidence or page context is missing, return the explicit gap; never invent a lookup or a successful write. Later phases must receive complete source evidence, existing pages and relevant prior results again. Emit only the requested phase output; no whole-corpus or multi-page batch is implied.\n\nReviewed company perspective: ${input.perspective}\nFiling categories: ${input.filing_categories.join(", ")}\nDirectory mappings under brain/: ${JSON.stringify(input.directories)}\n\nEvery Timeline entry and Take cites an internal evidence page that links to the original source. Confirmed meeting attendees have meaningful pages even if short. Shared quality rules do not authorize source selection, audience restrictions, privacy queues or external lookups. Inline links below are provenance; every rule required for this phase is included in these instructions.\n\n`;
      const pageFormat = ["meeting-page", "meeting-entities", "discussion-entities"].includes(phase.id)
        ? " Takes serialization (pinned takes-fence contract, before the Timeline): use exactly <!--- gbrain:takes:begin --> and <!--- gbrain:takes:end --> around a Markdown table with columns | # | claim | kind | who | weight | since | source |. Preserve existing stable positive row numbers; append new numbers. kind is fact, take, bet or hunch; who is the actual holder per the filing rules; weight uses the 0.05 grid in [0,1]; since is an evidenced ISO date/month or empty; source must contain the supplied [[internal-evidence-page]] link, never only a prose label. Superseded claims use ~~strikethrough~~ without renumbering. Escape literal pipes in cells. Omit the table when no Takes are supported."
        : "";
      const instructions = preface + phase.sections.map(key => {
        const text = sections.get(key);
        if (!text) throw new Error(`Missing phase guidance: ${key}`);
        return text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
          if (!directories.includes(key as typeof directories[number])) throw new Error("Unknown directory mapping");
          return input.directories[key as typeof directories[number]];
        });
      }).join("\n\n") + `\n\nPhase output contract: ${phase.output}${pageFormat}\n`;
      if (instructions.length > MAX_INSTRUCTION_CHARACTERS || instructions.includes("{{")) throw new Error(`Brain phase exceeds instruction capacity or has unresolved mappings: ${variant.id}`);
      const path = `agents/${input.agent_id}/skills/brain-${variant.id}/SKILL.md`;
      if (materials[path]) throw new Error("Duplicate Brain phase path");
      materials[path] = instructions;
      prompts.push({ agent_id: input.agent_id, path, model_task: variant.task, model_profile: variant.profile,
        max_instruction_characters: instructions.length, conversation_context: false });
      measurements.push({ phase: variant.id, path, sections: phase.sections, instructions: instructions.length,
        system: instructions.length + LANGUAGE_SYSTEM_PREFIX.length, bytes: Buffer.byteLength(instructions), digest: digest(instructions) });
    }
  }
  return { materials, prompts, report: { upstream: adoption.upstream, adoption_digest: digest(manifestText),
    inputs_digest: digest(JSON.stringify(input)), measurements, model_context_qualified: false,
    qualification: "Static coverage and sizes only. Qualify complete evidence, selected model context, output and elapsed time through the Artifact/generation path." } };
}
