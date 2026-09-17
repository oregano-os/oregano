import { BrainError, type BrainPage } from "./contracts.ts";
import { findTimelineSplitIndex, findBareTimelineSection } from "./upstream/timeline.ts";

export interface BrainTimelineAddition {
  date: string;
  summary: string;
  detail?: string;
  evidence: string[];
}

/** A small prose edit, not an event store or a model-generated page replacement. */
export function addBrainTimeline(page: BrainPage, addition: BrainTimelineAddition): string {
  const invalid = (): never => { throw new BrainError("invalid_input", "Timeline additions require a real YYYY-MM-DD event date, bounded single-line summary/detail and canonical evidence slugs."); };
  if (!addition || typeof addition.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(addition.date)
    || !Number.isFinite(Date.parse(addition.date)) || new Date(addition.date).toISOString().slice(0, 10) !== addition.date) invalid();
  const prose = (value: unknown, bound: number): value is string => typeof value === "string" && !!value.trim()
    && value.length <= bound && !/[\r\n\0]/.test(value) && !value.includes("<!--") && !value.includes("-->");
  if (!prose(addition.summary, 500) || (addition.detail !== undefined && !prose(addition.detail, 2000))
    || !Array.isArray(addition.evidence) || !addition.evidence.length || addition.evidence.length > 16
    || new Set(addition.evidence).size !== addition.evidence.length
    || addition.evidence.some(slug => typeof slug !== "string" || !/^[a-z][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,119}$/.test(slug))) invalid();
  const proseText = `${addition.summary.trim()}${addition.detail ? ` — ${addition.detail.trim()}` : ""}`;
  // A readable citation supplies the visible navigation. Keep the direct source
  // references in the same entry for the unchanged evidence validator/indexer.
  const hasCitation = /\\\[\[\[[^\[\]\n|]+\|Source: [^\]\n]+\]\]\\\]/.test(proseText);
  const references = hasCitation
    ? `<!-- Source evidence: ${addition.evidence.map(slug => `[[${slug}]]`).join(" ")} -->`
    : addition.evidence.map(slug => `\\[[[${slug}|Source: ${addition.date}]]\\]`).join(" ");
  const entry = `- ${addition.date}: ${proseText} ${references}`;
  // Exact duplicate protection also covers an intentional retry with a fresh key
  // after rereading. Source corrections still require an explicit replacement.
  const legacyEntry = `- ${addition.date}: ${proseText} ${addition.evidence.map(slug => `[[${slug}]]`).join(" ")}`;
  if (timelineProseLines(page.timeline).some(line => line.text === entry || line.text === legacyEntry)) return page.markdown;

  const raw = page.markdown, newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const header = raw.match(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)!;
  const body = raw.slice(header[0].length), lines = body.split(/\r?\n/);
  const offset = (line: number) => {
    let position = 0;
    for (let i = 0; i < line; i++) {
      const end = body.indexOf("\n", position);
      if (end < 0) return body.length;
      position = end + 1;
    }
    return position;
  };
  const split = findTimelineSplitIndex(lines);
  let current: string, history: string;
  if (split >= 0) {
    // Replace only a legacy delimiter; keep all other bytes, including whitespace.
    current = header[0] + body.slice(0, offset(split));
    history = body.slice(offset(split) + lines[split].length);
  } else {
    const bare = findBareTimelineSection(lines);
    if (bare) {
      const start = offset(bare.start), end = Math.min(body.length, offset(bare.end));
      history = newline + body.slice(start, end);
      current = header[0] + body.slice(0, start) + body.slice(end);
    } else { current = raw; history = newline; }
    if (!current.endsWith("\n")) current += newline;
    current += newline;
  }
  // Insert among ordinary dated bullets when present, without sorting or
  // rewriting existing prose. Legacy undated history remains untouched.
  const older = timelineProseLines(history).find(line => {
    const match = /^[ \t]*[-*+]\s+(?:\*\*)?(\d{4}-\d{2}-\d{2})\b/.exec(line.text);
    return match && match[1] <= addition.date;
  });
  const position = older?.offset ?? history.length;
  const before = history.slice(0, position), after = history.slice(position);
  const separator = before.endsWith("\n") ? "" : newline;
  return current + "<!-- timeline -->" + before + separator + entry + newline + after;
}

/** Fenced examples are preserved text, not events or duplicate write receipts. */
function timelineProseLines(text: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let fence: string | undefined, length = 0;
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(match[0]);
    if (marker) {
      if (!fence) { fence = marker[1][0]; length = marker[1].length; }
      else if (marker[1][0] === fence && marker[1].length >= length && !match[0].slice(marker[0].length).trim()) fence = undefined;
      continue;
    }
    if (!fence) lines.push({ text: match[0], offset: match.index });
  }
  if (fence) throw new BrainError("ambiguous_target", "Timeline has an unclosed code fence; repair it with a reviewed full-page replacement before adding an event.");
  return lines;
}
