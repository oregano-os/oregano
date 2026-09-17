/** Adopted from garrytan/gbrain@a6be012a3bcfac42e279630aedec5cda4a450e29. MIT; see LICENSE. */
export function splitBody(body: string): { compiled_truth: string; timeline: string } {
  const lines = body.split('\n');
  const splitIndex = findTimelineSplitIndex(lines);

  if (splitIndex !== -1) {
    const compiled_truth = lines.slice(0, splitIndex).join('\n');
    const timeline = lines.slice(splitIndex + 1).join('\n');
    return { compiled_truth, timeline };
  }

  const section = findBareTimelineSection(lines);
  if (section) {
    return {
      // Only the timeline-shaped section moves; anything from the next H2
      // onward stays in compiled_truth (later unrelated sections survive).
      compiled_truth: lines.slice(0, section.start).concat(lines.slice(section.end)).join('\n'),
      // Heading line kept: it belongs to the timeline content.
      timeline: lines.slice(section.start, section.end).join('\n'),
    };
  }

  return { compiled_truth: body, timeline: '' };
}

/**
 * Line index of the first recognized timeline sentinel, or -1. Exported for
 * the timeline write-through's on-disk splice (timeline-write-through.ts),
 * which must locate the sentinel in raw file text without re-serializing the
 * page. Callers pass BODY lines (after frontmatter — splitBody's own call
 * shape) so the frontmatter's `---` delimiters can't false-positive rule 3.
 */
export function findTimelineSplitIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === '<!-- timeline -->' || trimmed === '<!--timeline-->') {
      return i;
    }

    if (trimmed === '--- timeline ---' || /^---\s+timeline\s+---$/i.test(trimmed)) {
      return i;
    }

    if (trimmed === '---') {
      const beforeContent = lines.slice(0, i).join('\n').trim();
      if (beforeContent.length === 0) continue;

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next.length === 0) continue;
        if (/^##\s+(timeline|history)\s*$/i.test(next)) return i;
        break;
      }
    }
  }
  return -1;
}

/** A timeline entry line: a bullet whose text starts with a 4-digit year
 *  (optionally bolded), e.g. `- 2024-05-01: Series A closed`, `- 2020: Founded`. */
const DATED_BULLET_RE = /^\s*[-*+]\s+\**\d{4}\b/;

/**
 * #2225 fallback scan: the first bare `## Timeline` / `## History` H2 heading
 * with no sentinel before it, GATED on the section actually looking like a
 * timeline — otherwise an ordinary wiki page with a prose '## History'
 * section would lose everything after that heading into the timeline half.
 * A section qualifies only when its content (up to the next H2 or EOF) is
 * dated bullets (`DATED_BULLET_RE`, blank lines and indented bullet
 * continuations allowed) with at least one bullet. Lines inside fenced code
 * blocks (```/~~~) are skipped (same fence tracking as inferTitleFromBody),
 * and a heading with an empty prefix is skipped too — a heading-first body
 * would split into an empty compiled_truth, which is worse than not
 * splitting. Returns the section's [start, end) line range (heading
 * included, next H2 excluded) or null.
 */
export function findBareTimelineSection(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/^##\s+(timeline|history)\b/i.test(lines[i].trim())) continue;
    const beforeContent = lines.slice(0, i).join('\n').trim();
    if (beforeContent.length === 0) continue;

    // Lookahead: section extent + timeline shape. Any non-blank line that is
    // neither a dated bullet nor a continuation of one (incl. fence openers)
    // disqualifies THIS heading; the outer scan keeps looking for a later one.
    let end = lines.length;
    let datedBullets = 0;
    let shaped = true;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (/^##\s+\S/.test(trimmed)) { end = j; break; }
      if (trimmed.length === 0) continue;
      if (DATED_BULLET_RE.test(lines[j])) { datedBullets++; continue; }
      if (datedBullets > 0 && /^\s{2,}\S/.test(lines[j])) continue; // wrapped bullet
      shaped = false;
      break;
    }
    if (shaped && datedBullets > 0) return { start: i, end };
  }
  return null;
}
