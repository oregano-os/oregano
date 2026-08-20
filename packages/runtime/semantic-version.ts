const numericIdentifier = "(?:0|[1-9]\\d*)";
const nonNumericIdentifier = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;

const exactSemanticVersion = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
    `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);

export function isExactSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && exactSemanticVersion.test(value);
}

export function requireExactSemanticVersion(value: unknown, label: string): string {
  if (!isExactSemanticVersion(value)) {
    throw new Error(`${label} must be an exact Semantic Versioning 2.0.0 version without leading zeroes.`);
  }
  return value;
}
