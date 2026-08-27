export function postgresTimestampToIso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Postgres timestamp value is invalid.");
  return parsed.toISOString();
}
