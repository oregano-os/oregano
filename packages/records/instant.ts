const pattern = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Exact UTC nanoseconds; Date is used only for the integral second. */
export function recordInstant(value: unknown, label: string): bigint {
  const parts = typeof value === "string" ? pattern.exec(value) : null;
  if (!parts) throw new Error(`${label} must be an ISO timestamp with timezone and at most nine fractional digits`);
  const year = Number(parts[1]); const month = Number(parts[2]); const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) throw new Error(`${label} must be an ISO timestamp with a valid calendar date`);
  const integral = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${parts[8]}`);
  if (!Number.isFinite(integral) || integral < -62_167_219_200_000 || integral > 253_402_300_799_000) throw new Error(`${label} must be an ISO timestamp with timezone`);
  return BigInt(integral) * 1_000_000n + BigInt((parts[7] ?? "").padEnd(9, "0"));
}

export function canonicalRecordInstant(value: string): string {
  const nanos = recordInstant(value, "Record instant");
  // BigInt division truncates towards zero; floor for pre-epoch fractions.
  const fraction = ((nanos % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  const seconds = (nanos - fraction) / 1_000_000_000n;
  const digits = fraction.toString().padStart(9, "0").replace(/0+$/, "").padEnd(3, "0");
  return new Date(Number(seconds) * 1_000).toISOString().replace(/\.\d{3}Z$/, `.${digits}Z`);
}

export function compareRecordInstants(left: string, right: string): number {
  const a = recordInstant(left, "Record instant"); const b = recordInstant(right, "Record instant");
  return a < b ? -1 : a > b ? 1 : 0;
}
