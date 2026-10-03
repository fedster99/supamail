/**
 * Search filter rules shared by every engine. Postgres compiles them to SQL; a
 * hosted index translates the same data, so the engines cannot drift.
 */

/** Relative date units (`7d`, `2w`, `3m`, `1y`, `12h`) as Postgres intervals. */
export const RELATIVE_DATE_INTERVALS: Readonly<Record<string, string>> = {
  h: "1 hour",
  d: "1 day",
  w: "1 week",
  m: "1 month",
  y: "1 year"
};

const RELATIVE_DATE = /^(\d+)([hdwmy])$/;
const ABSOLUTE_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** True for a relative date spec such as `7d`. */
export function isRelativeDate(value: string): boolean {
  return RELATIVE_DATE.test(value);
}

/** True for a real calendar date or date-time: `2026-01-31`, `2026-01-31T09:30Z`. */
export function isValidAbsoluteDate(value: string): boolean {
  const match = ABSOLUTE_DATE.exec(value);
  if (!match) return false;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour < 24 && minute < 60 && second < 60;
}

/**
 * The instant a relative date names, counted back from `now`. Months and years are
 * calendar steps that keep the day, clamped to the month's end, as a Postgres
 * interval does: 31 March minus one month is 28 February.
 */
export function resolveRelativeDate(value: string, now: Date): Date {
  const match = RELATIVE_DATE.exec(value);
  if (!match) throw new RangeError(`not a relative date: ${value}`);
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
