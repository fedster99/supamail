/**
 * Search filter rules shared by every engine. Postgres compiles them to SQL; a
 * hosted index translates the same data, so the engines cannot drift.
 */

// A relative date reaches back at most about 100 years; larger values are rejected
// as invalid rather than overflowing a timestamp.
const RELATIVE_DATE_MAX: Readonly<Record<string, number>> = { h: 876_000, d: 36_500, w: 5_200, m: 1_200, y: 100 };
const RELATIVE_DATE = /^(\d{1,6})([hdwmy])$/;
// Date, optional time (hours and minutes, then optional seconds and fraction), and an
// optional zone: Z, UTC, or an offset of at most ±15:59, as Postgres accepts.
const ABSOLUTE_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(?:Z| ?UTC|([+-])(\d{2})(?::?(\d{2}))?)?)?$/;

/** True for a relative date spec such as `7d`, at most about 100 years back. */
export function isRelativeDate(value: string): boolean {
  const match = RELATIVE_DATE.exec(value);
  return match !== null && Number(match[1]) <= RELATIVE_DATE_MAX[match[2]]!;
}

/**
 * The instant an absolute date or date-time names, or null when it is not a real one.
 * A value without a zone is UTC. Fractions are kept to the millisecond (IMAP dates
 * have whole seconds). The instant must fall in years 1-9999, which Postgres accepts.
 */
export function parseAbsoluteDate(value: string): Date | null {
  const match = ABSOLUTE_DATE.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const end = new Date(0);
  end.setUTCFullYear(year, month, 0); // the last day of `month`, without the 0-99 → 19xx mapping
  const midnight = hour === 24 && minute === 0 && second === 0 && match[7] === undefined; // end of day
  const offsetOk = match[8] === undefined || (Number(match[9]) <= 15 && Number(match[10] ?? 0) < 60);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= end.getUTCDate() &&
    (hour < 24 || midnight) && minute < 60 && second < 60 && offsetOk)) return null;
  const millis = Math.floor(Number(`0${match[7] ?? ""}`) * 1000);
  const offsetMinutes = match[8] === undefined ? 0
    : (match[8] === "-" ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10] ?? 0));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  date.setTime(date.getTime() - offsetMinutes * 60_000);
  const resolvedYear = date.getUTCFullYear();
  return resolvedYear >= 1 && resolvedYear <= 9999 ? date : null;
}

/** True for a real calendar date or date-time: `2026-01-31`, `2026-01-31T09:30Z`. */
export function isValidAbsoluteDate(value: string): boolean {
  return parseAbsoluteDate(value) !== null;
}

/**
 * The instant a relative date names, counted back from `now`. Months and years are
 * calendar steps that keep the day, clamped to the month's end: 31 March minus one
 * month is 28 February. Every engine, Postgres included, uses this one resolver.
 */
export function resolveRelativeDate(value: string, now: Date): Date {
  const match = RELATIVE_DATE.exec(value);
  if (!match || !isRelativeDate(value)) throw new RangeError(`not a relative date: ${value}`);
  const amount = Number(match[1]);
  const date = new Date(now.getTime());
  if (match[2] === "m" || match[2] === "y") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (match[2] === "m" ? amount : amount * 12));
    date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  } else {
    date.setTime(date.getTime() - amount * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]]!);
  }
  return date;
}

/**
 * The instant a valid date filter value names: a relative spec counted back from
 * `now`, or an absolute date-time (UTC when it has no zone). Every engine binds this
 * instant, so all engines read a date filter the same way.
 */
export function resolveDate(value: string, now: Date): Date {
  if (isRelativeDate(value)) return resolveRelativeDate(value, now);
  const date = parseAbsoluteDate(value);
  if (!date) throw new RangeError(`not a valid date: ${value}`);
  return date;
}

/** What a `filetype:` value matches in an attachment's lowercase MIME type. */
export type FiletypeMatch =
  | { kind: "mimes"; mimes: readonly string[] }
  | { kind: "prefix"; prefix: string }
  | { kind: "contains"; text: string };

const FILETYPE_MIMES: Readonly<Record<string, readonly string[]>> = {
  pdf: ["application/pdf"],
  zip: ["application/zip", "application/x-zip-compressed", "application/gzip", "application/x-tar", "application/x-7z-compressed"],
  doc: ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  sheet: ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
};
const FILETYPE_ALIASES: Readonly<Record<string, string>> = { archive: "zip", word: "doc", spreadsheet: "sheet", excel: "sheet" };
const FILETYPE_PREFIXES = new Set(["image", "video", "audio", "text"]);

export function filetypeMatch(value: string): FiletypeMatch {
  const type = value.toLowerCase();
  if (FILETYPE_PREFIXES.has(type)) return { kind: "prefix", prefix: `${type}/` };
  const mimes = FILETYPE_MIMES[FILETYPE_ALIASES[type] ?? type];
  return mimes ? { kind: "mimes", mimes } : { kind: "contains", text: type };
}

/**
 * The glob a `filename:` value matches, case-insensitively. A value with `*` or `?`
 * is the user's own pattern; any other value matches as a substring.
 */
export function filenameGlob(value: string): string {
  return /[*?]/.test(value) ? value : `*${value}*`;
}
