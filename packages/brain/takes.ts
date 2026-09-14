/** Adapted from the pinned GBrain takes-fence contract; see upstream/LICENSE. */
import { parseRowCells, isSeparatorRow, stripStrikethrough, escapeFenceCell } from "./upstream/fence.ts";
import type { BrainConfiguration, BrainDiagnostic, BrainTake } from "./contracts.ts";

export const TAKES_BEGIN = "<!--- gbrain:takes:begin -->";
export const TAKES_END = "<!--- gbrain:takes:end -->";
const HEADER = ["#", "claim", "kind", "who", "weight", "since", "source"];

/** Pinned GBrain normalization: clamp then round to the 0.05 grid. */
export function normalizeWeightForStorage(raw: number | null | undefined): { weight: number; clamped: boolean } {
  let w = raw ?? 0.5;
  let clamped = false;
  if (!Number.isFinite(w)) { clamped = true; w = 0.5; }
  else if (w < 0 || w > 1) { clamped = true; w = Math.max(0, Math.min(1, w)); }
  return { weight: Math.round(w * 20) / 20, clamped };
}

const validDate = (value: string) => /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)
  && Number.isFinite(Date.parse(value.length === 7 ? `${value}-01` : value))
  && new Date(value.length === 7 ? `${value}-01` : value).toISOString().startsWith(value);

export function parseTakes(body: string, path: string, config: BrainConfiguration): { takes: BrainTake[]; diagnostics: BrainDiagnostic[]; prose: string } {
  const diagnostics: BrainDiagnostic[] = [], takes: BrainTake[] = [];
  const issue = (code: string, message: string, row_num?: number, severity: BrainDiagnostic["severity"] = "error") => diagnostics.push({ code, message, path, severity, ...(row_num === undefined ? {} : { row_num }) });
  const start = body.indexOf(TAKES_BEGIN), end = body.indexOf(TAKES_END);
  if (start < 0 && end < 0 && !body.includes("gbrain:takes:")) return { takes, diagnostics, prose: body };
  if (start < 0 || end < start || body.indexOf(TAKES_BEGIN, start + TAKES_BEGIN.length) !== -1
    || body.indexOf(TAKES_END, end + TAKES_END.length) !== -1) {
    issue("takes_fence_invalid", "Use one complete canonical Takes fence with triple-dash comment markers.");
    return { takes, diagnostics, prose: "" };
  }
  const prose = body.slice(0, start) + body.slice(end + TAKES_END.length);
  if (prose.includes("gbrain:takes:")) issue("takes_fence_invalid", "Unexpected Takes marker outside the canonical fence.");
  const lines = body.slice(start + TAKES_BEGIN.length, end).split("\n").filter(line => line.trim());
  if (JSON.stringify(parseRowCells(lines[0] ?? "")) !== JSON.stringify(HEADER)
    || !isSeparatorRow(parseRowCells(lines[1] ?? "") ?? []) || parseRowCells(lines[1])?.length !== 7) {
    issue("takes_table_invalid", "Takes require the seven columns #, claim, kind, who, weight, since and source.");
    return { takes, diagnostics, prose };
  }
  const seen = new Set<number>();
  for (const line of lines.slice(2)) {
    const cells = parseRowCells(line);
    if (!cells || cells.length !== 7) { issue("takes_table_invalid", "A Take row must have exactly seven cells."); continue; }
    const [number, rawClaim, kind, holder, rawWeight, dates, source] = cells;
    const row = Number(number);
    if (!/^\d+$/.test(number) || !Number.isSafeInteger(row) || row < 1 || seen.has(row)) { issue("takes_row_invalid", "Take row IDs must be unique positive integers."); continue; }
    seen.add(row);
    if (!["fact", "take", "bet", "hunch"].includes(kind) || !rawClaim || !source) { issue("takes_row_invalid", "Claim, supported kind and evidence source are required.", row); continue; }
    const holderDirectories = Object.values(config.types).filter(type => type.role === "person" || type.role === "company").map(type => type.directory);
    if (holder !== "world" && holder !== "brain" && !(holderDirectories.includes(holder.split("/")[0]) && /^[a-z0-9][a-z0-9._/-]*$/.test(holder)
      && !holder.split("/").some(part => !part || part === "." || part === ".."))) {
      issue("takes_holder_invalid", "Holder must be world, brain or a declared person/company page reference.", row);
    }
    if (!rawWeight || !Number.isFinite(Number(rawWeight))) { issue("takes_weight_invalid", "Take weight must be a finite number.", row); continue; }
    const normalized = normalizeWeightForStorage(Number(rawWeight));
    if (normalized.weight !== Number(rawWeight)) issue("takes_weight_normalized", "Weight was normalized to the 0.05 grid in [0,1].", row, "warning");
    const range = dates.split(/\s*(?:→|->)\s*/);
    if (dates && (range.length > 2 || range.some(date => !validDate(date)) || (range.length === 2 && range[1] < range[0]))) {
      issue("takes_date_invalid", "Take dates require evidenced ISO months/days or an ordered start/end range.", row);
    }
    const claim = stripStrikethrough(rawClaim);
    takes.push({ row_num: row, claim: claim.text, kind: kind as BrainTake["kind"], holder, weight: normalized.weight,
      ...(dates ? { since_date: range[0] } : {}), ...(range[1] ? { until_date: range[1] } : {}), source, active: !claim.struck });
  }
  return { takes, diagnostics, prose };
}

export function renderTakes(takes: BrainTake[]): string {
  const rows = takes.map(take => [String(take.row_num), take.active ? take.claim : `~~${take.claim}~~`, take.kind,
    take.holder, String(take.weight), take.until_date ? `${take.since_date ?? ""} → ${take.until_date}` : take.since_date ?? "", take.source]
    .map(escapeFenceCell).join(" | "));
  return `${TAKES_BEGIN}\n| ${HEADER.join(" | ")} |\n|---|-------|------|-----|--------|-------|--------|\n${rows.map(row => `| ${row} |`).join("\n")}\n${TAKES_END}`;
}
