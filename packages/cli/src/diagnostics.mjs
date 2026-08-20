export const diagnostic = (code, severity, message, options = {}) => ({
  code,
  severity,
  message,
  ...(options.field ? { field: options.field } : {}),
  ...(options.file ? { file: options.file } : {}),
  ...(options.line ? { line: options.line } : {}),
  ...(options.hint ? { hint: options.hint } : {}),
});

export const hasErrors = (diagnostics) =>
  diagnostics.some((item) => item.severity === "error");

const severityRank = { error: 0, warning: 1, info: 2 };

export const sortDiagnostics = (diagnostics) => [...diagnostics].sort((a, b) =>
  (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
  (a.file ?? "").localeCompare(b.file ?? "") ||
  (a.line ?? 0) - (b.line ?? 0) ||
  a.code.localeCompare(b.code));

export const printDiagnostics = (diagnostics, { format = "human", summary } = {}) => {
  const sorted = sortDiagnostics(diagnostics);
  const summaryText = summary && typeof summary === "object"
    ? Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(", ")
    : summary;
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({
      ok: !hasErrors(sorted),
      summary: summary ?? null,
      diagnostics: sorted,
    }, null, 2)}\n`);
    return;
  }

  if (sorted.length === 0) {
    process.stdout.write(`✓ ${summaryText ?? "No diagnostics."}\n`);
    return;
  }

  for (const item of sorted) {
    const marker = item.severity === "error" ? "✗" : item.severity === "warning" ? "!" : "·";
    const location = item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : "";
    process.stdout.write(`${marker} ${item.severity.toUpperCase()} ${item.code}${location}\n  ${item.message}\n`);
    if (item.hint) process.stdout.write(`  Hint: ${item.hint}\n`);
  }

  const errors = sorted.filter((item) => item.severity === "error").length;
  const warnings = sorted.filter((item) => item.severity === "warning").length;
  process.stdout.write(`\n${summaryText ?? "Validation complete"}: ${errors} error(s), ${warnings} warning(s).\n`);
};
