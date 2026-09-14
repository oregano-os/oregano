/** Adopted from garrytan/gbrain@a6be012a3bcfac42e279630aedec5cda4a450e29. MIT; see LICENSE. */
export function parseRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\' && inner[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Markdown table separator detector. A row like `|---|---|---|` (or with
 * colons for alignment) returns true. Used to skip past the header
 * separator when iterating fence rows.
 */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^[-:\s]+$/.test(c)) && cells.length > 0;
}

/**
 * Detect strikethrough wrapping on a cell.
 *
 * `~~text~~` → `{ text: 'text', struck: true }`
 * `text`     → `{ text: 'text', struck: false }`
 *
 * Used by both fences to mark a row as inactive (takes: superseded /
 * retracted; facts: superseded / forgotten — the parser distinguishes
 * via the `context` cell at the domain layer, not here).
 */
export function stripStrikethrough(s: string): { text: string; struck: boolean } {
  const m = s.match(/^~~(.+?)~~$/);
  if (m) return { text: m[1].trim(), struck: true };
  return { text: s, struck: false };
}

/**
 * Trim a cell's surrounding whitespace and collapse empty / whitespace-only
 * cells to `undefined`. The `''` → `undefined` mapping is what callers want
 * for optional string fields.
 */
export function parseStringCell(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Escape a value for safe placement inside a pipe-separated cell. Replaces
 * any literal `|` with `\|` so the table layout stays intact. `parseRowCells`
 * is the inverse and decodes the escape after identifying cell boundaries.
 */
export function escapeFenceCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}
