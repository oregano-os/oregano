const assertInstant = (value: string): number => {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`Invalid instant '${value}'`);
  return instant;
};

const assertDate = (value: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date '${value}'`);
  }
};

const assertTimeZone = (timeZone: string): void => {
  new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
};

const partsAt = (instant: number, timeZone: string): Record<string, number> => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
};

export function localDateAt(instant: string, timeZone: string): string {
  assertTimeZone(timeZone);
  const parts = partsAt(assertInstant(instant), timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addLocalCalendarDays(value: string, days: number): string {
  assertDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Convert a reviewed local time and IANA timezone into one deterministic UTC instant. */
export function zonedLocalDateTimeToIso(date: string, time: string, timeZone: string): string {
  assertDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Invalid local time '${time}'`);
  assertTimeZone(timeZone);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = partsAt(candidate, timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += target - represented;
  }
  const actual = partsAt(candidate, timeZone);
  if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute) {
    throw new Error(`Local time '${date} ${time}' does not exist in timezone '${timeZone}'`);
  }
  return new Date(candidate).toISOString();
}

/** Return the first instant of the next local calendar day. */
export function nextLocalDayStartIso(instant: string, timeZone: string): string {
  const nextDate = addLocalCalendarDays(localDateAt(instant, timeZone), 1);
  return zonedLocalDateTimeToIso(nextDate, "00:00", timeZone);
}
