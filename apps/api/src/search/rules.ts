import type { SearchFilter } from "./types.js";

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
 * is the user's own pattern; any other value matches as a substring. Only `*` and
 * `?` are wildcards; an engine escapes every other character in its own syntax.
 */
export function filenameGlob(value: string): string {
  return /[*?]/.test(value) ? value : `*${value}*`;
}

/** An RFC Message-ID as the mirror stores it: no angle brackets, lowercase. A value
 * copied from a header (`<ABC@example.com>`) matches the same message. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().replace(/^<|>$/g, "").toLowerCase() || null;
}

/** One mirrored folder, as `in:` resolves against it. */
export interface FolderRow {
  account_id: string;
  path: string;
  delimiter: string | null;
  special_use: string | null;
}

/** The folders a `folder` filter matched, per Mailbox Account. */
export interface FolderRef {
  account_id: string;
  path: string;
}

// A role name selects every folder with its special-use flag or a common provider name,
// so `in:sent` covers a flagged Sent folder and an unflagged "Sent Messages" alike. The
// Inbox is only the flagged folder or the INBOX path itself, never a subfolder named Inbox.
const FOLDER_ROLES: ReadonlyArray<{ role: string; specialUse: string; names: readonly string[] }> = [
  { role: "inbox", specialUse: "\\inbox", names: [] },
  { role: "sent", specialUse: "\\sent", names: ["sent", "sent messages", "sent items", "sent mail"] },
  { role: "drafts", specialUse: "\\drafts", names: ["drafts", "draft"] },
  { role: "trash", specialUse: "\\trash", names: ["trash", "deleted messages", "deleted items", "bin"] },
  { role: "archive", specialUse: "\\archive", names: ["archive", "archives"] },
  { role: "junk", specialUse: "\\junk", names: ["junk", "spam", "junk e-mail", "junk email", "bulk mail"] }
];

/** A folder path as `/`-separated lowercase segments, whatever the account's delimiter. */
function folderSegments(path: string, delimiter: string | null): string[] {
  const parts = delimiter ? path.split(delimiter) : [path];
  return parts.flatMap((part) => part.split("/")).map((part) => part.toLowerCase());
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

/** How `value` names `folder`: by full path (or a subtree below one), by role, or by
 * last name; null when it does not. */
function folderMatchKind(value: string, folder: FolderRow): "path" | "role" | "leaf" | null {
  const segments = folderSegments(folder.path, folder.delimiter);
  const subtree = value.endsWith("/*") || (folder.delimiter !== null && value.endsWith(`${folder.delimiter}*`));
  if (subtree) {
    const base = folderSegments(value.slice(0, -2), folder.delimiter);
    return segments.length > base.length && base.every((part, index) => segments[index] === part) ? "path" : null;
  }
  const wanted = folderSegments(value.replace(/^\\/, ""), folder.delimiter);
  if (segments.join("/") === wanted.join("/")) return "path";
  if (wanted.length > 1) return null;
  const leaf = segments.at(-1)!;
  const role = FOLDER_ROLES.find((candidate) => candidate.role === wanted[0] || candidate.names.includes(wanted[0]));
  if (role) return folder.special_use?.toLowerCase() === role.specialUse || role.names.includes(leaf) ? "role" : null;
  return leaf === wanted[0] ? "leaf" : null;
}

/**
 * The folders a `folder:`/`in:` value names in each account. The value may be a full
 * path written with `/` or the account's own delimiter, a folder's last name (`Legal`
 * for `INBOX.INBOX.Legal`, used only where no folder has that full path), or a role (`sent`, `\\Sent`, `trash`, `drafts`, `archive`,
 * `junk`, `inbox`), which covers every folder with that special-use flag or a common
 * name for it. A trailing `/*` (or the delimiter and `*`) selects the folders below a
 * full path. Matching ignores case. With no match, the warning names the closest folders.
 */
export function resolveFolder(value: string, folders: readonly FolderRow[]): { folders: FolderRef[]; warning: string | null } {
  const kinds = folders.map((folder) => ({ folder, kind: folderMatchKind(value, folder) }));
  // A last name counts only in an account where no folder has that full path.
  const pathAccounts = new Set(kinds.filter(({ kind }) => kind === "path").map(({ folder }) => folder.account_id));
  const matched = kinds
    .filter(({ folder, kind }) => kind !== null && (kind !== "leaf" || !pathAccounts.has(folder.account_id)))
    .map(({ folder }) => folder);
  if (matched.length > 0) {
    return { folders: matched.map(({ account_id, path }) => ({ account_id, path })), warning: null };
  }
  const wanted = value.replace(/[/.]?\*$/, "").toLowerCase().split(/[/.]/).filter(Boolean).at(-1) ?? "";
  const closest = folders
    .map((folder) => ({ path: folder.path, distance: editDistance(wanted, folderSegments(folder.path, folder.delimiter).at(-1)!) }))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path))
    .map(({ path }) => path)
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 3);
  return {
    folders: [],
    warning: `folder "${value}" not found; it matches nothing` + (closest.length ? `. Closest folders: ${closest.join(", ")}` : "")
  };
}

/** True when a filter, or a member of its OR group, scopes by folder. */
export function hasFolderFilter(filter: SearchFilter): boolean {
  return filter.kind === "folder" || (filter.kind === "or" && filter.filters.some(hasFolderFilter));
}

/** Resolve every folder filter, including OR members, against the searched accounts'
 * folders. Each engine matches the resolved (account, path) pairs exactly. */
export function resolveFolderFilters(filters: SearchFilter[], folders: readonly FolderRow[], warnings: string[]): SearchFilter[] {
  return filters.map(function resolve(filter): SearchFilter {
    if (filter.kind === "or") return { ...filter, filters: filter.filters.map(resolve) };
    if (filter.kind !== "folder") return filter;
    const resolved = resolveFolder(filter.value, folders);
    if (resolved.warning && !warnings.includes(resolved.warning)) warnings.push(resolved.warning);
    return { ...filter, folders: resolved.folders };
  });
}
