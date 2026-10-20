import { readRecords } from './admin.attendees.import.ts';
import { readTypedTicketCode } from './admin.attendees.rules.ts';

import { startsLikeFormula } from '../../constants/csv.ts';
import { isAdminUsername } from '../../constants/admin-username.ts';
import { REDEEMABLE_ITEMS, isRedemptionItem } from '../../constants/pass.ts';

import type { RedemptionItem } from '../../constants/pass.ts';
import type { AttendeeEntry } from '../../types/attendee.ts';

/**
 * Reading a volunteer permissions CSV, and deciding what loading it would
 * change. Also carries the pass's `show_admin_link` and `admin_username`,
 * which grant nothing but belong to the same coordinator-owned file. `team`,
 * `team_role` and `checkin_time` are loaded by the roster import
 * (`admin.attendees.import.ts`), not here.
 *
 * Pure: `scripts/db/set-volunteer-permissions.ts` reads the rows the plan needs
 * and writes what it decides. Kept apart from the roster import on purpose, so
 * re-loading the sign-up system's export can never grant or revoke access.
 *
 * **Replace, not merge, and only what the file names.** A permission column
 * the header leaves out is never written; a volunteer the file does not list
 * is never touched. A blank cell is a problem, not "unchanged" or "false" —
 * except under `admin_username`, where it clears the link, since that is the
 * only way to unassign someone.
 *
 * Problems carry line numbers and ticket codes only, as in
 * `admin.attendees.import.ts`.
 */

/** Every header the file may carry, in the order the documentation lists. */
export const PERMISSION_COLUMNS = [
  'ticket_code',
  'can_redeem',
  'redeem_scopes',
  'can_draw',
  'show_admin_link',
  'admin_username',
] as const;

type PermissionColumn = (typeof PERMISSION_COLUMNS)[number];

/** The permission columns an import may write. */
export type PermissionField = Exclude<PermissionColumn, 'ticket_code'>;

const PERMISSION_FIELDS: readonly PermissionField[] = [
  'can_redeem',
  'redeem_scopes',
  'can_draw',
  'show_admin_link',
  'admin_username',
];

/**
 * Known administrator accounts, by username: whether each is active. Read from
 * `admins` by the caller; the import never queries.
 */
export type KnownAdmins = ReadonlyMap<string, { isActive: boolean }>;

/** The cell value that stands for an empty `redeem_scopes`. */
export const NO_SCOPES = 'none';

/** Separator between items in a `redeem_scopes` cell. */
export const SCOPE_SEPARATOR = ';';

/** Items in the order they are stored, so comparison ignores cell order. */
export const ITEM_ORDER = Object.keys(REDEEMABLE_ITEMS) as RedemptionItem[];

/** Permission values as they would be stored. */
export interface PermissionValues {
  can_redeem: boolean;
  redeem_scopes: RedemptionItem[];
  can_draw: boolean;
  show_admin_link: boolean;
  admin_username: string | null;
}

/** One file line, validated. Holds only the columns the header names. */
export interface PermissionRow {
  /** Line in the file the record ends on, for messages. */
  line: number;
  ticketCode: string;
  values: Partial<PermissionValues>;
}

/** The outcome of reading a permissions file. */
export interface ParsedPermissions {
  rows: PermissionRow[];
  /** Anything that makes the file unloadable. */
  problems: string[];
}

/** An attendee row as the import reads it back, across every event. */
export type ExistingVolunteer = Pick<
  AttendeeEntry,
  | 'attendee_id'
  | 'event_id'
  | 'ticket_code'
  | 'attendee_role'
  | 'archived_at'
  | PermissionField
>;

/** One volunteer whose permissions the file changes. */
export interface PlannedPermissionUpdate {
  row: PermissionRow;
  attendeeId: string;
  changed: PermissionField[];
  /** Stored values before the write, for the report. */
  before: PermissionValues;
  /**
   * Whether the volunteer loses anything they could do: the raffle, or an item
   * they could record. Scopes only count while `can_redeem` is on.
   */
  revoked: boolean;
  archived: boolean;
}

/** What loading a permissions file would do. */
export interface PermissionPlan {
  updates: PlannedPermissionUpdate[];
  unchanged: number;
  /** Loaded anyway, but worth a second look. */
  warnings: string[];
  problems: string[];
}

/**
 * Orders items as {@link REDEEMABLE_ITEMS} does.
 *
 * @param items - Items in any order.
 */
const inItemOrder = (items: readonly string[]): RedemptionItem[] =>
  ITEM_ORDER.filter((item) => items.includes(item));

/**
 * Reads a `true` / `false` cell.
 *
 * @param column - Column name, for the message.
 * @param value - The trimmed cell.
 * @throws {Error} For anything else, blank included.
 */
const readFlag = (column: PermissionField, value: string): boolean => {
  const flag = value.toLowerCase();

  if (flag === 'true') return true;
  if (flag === 'false') return false;

  throw new Error(`${column} must be true or false`);
};

/**
 * Reads an `admin_username` cell. Whether the account exists is
 * {@link planPermissions}' job.
 *
 * @param value - The trimmed cell.
 * @returns The lowercased username, or `null` for a blank cell, which clears
 *   the link.
 * @throws {Error} If it is not a well-formed administrator username.
 */
const readAdminUsername = (value: string): string | null => {
  const username = value.toLowerCase();

  if (username === '') return null;

  if (!isAdminUsername(username)) {
    throw new Error('admin_username is not a valid administrator username');
  }

  return username;
};

/**
 * Reads a `redeem_scopes` cell: {@link SCOPE_SEPARATOR}-separated items, or
 * {@link NO_SCOPES}.
 *
 * @param value - The trimmed cell.
 * @throws {Error} For a blank cell, an unknown item or a repeated one.
 */
const readScopes = (value: string): RedemptionItem[] => {
  const cell = value.toLowerCase();
  const allowed = `${ITEM_ORDER.join(', ')} or ${NO_SCOPES}`;

  if (cell === '') throw new Error(`redeem_scopes is blank; use ${allowed}`);
  if (cell === NO_SCOPES) return [];

  const items = cell.split(SCOPE_SEPARATOR).map((item) => item.trim());

  for (const item of items) {
    if (!isRedemptionItem(item)) {
      throw new Error(`redeem_scopes "${item}" is not one of ${allowed}`);
    }
  }

  if (new Set(items).size !== items.length) {
    throw new Error('redeem_scopes lists an item twice');
  }

  return inItemOrder(items);
};

/** Columns this file once carried; the roster import loads them now. */
const MOVED_COLUMNS: ReadonlySet<string> = new Set([
  'team',
  'team_role',
  'checkin_time',
]);

/**
 * Maps each known header to its cell index.
 *
 * @param header - The first record.
 * @param problems - Appended to in place.
 */
const readHeader = (
  header: readonly string[],
  problems: string[],
): Map<PermissionColumn, number> => {
  const columns = new Map<PermissionColumn, number>();

  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();

    if (MOVED_COLUMNS.has(name)) {
      problems.push(
        `header: "${name}" is loaded by the roster import (import-attendees.ts), not this file`,
      );
    } else if (!(PERMISSION_COLUMNS as readonly string[]).includes(name)) {
      problems.push(
        `header: unknown column "${name}"; columns are ${PERMISSION_COLUMNS.join(', ')}`,
      );
    } else if (columns.has(name as PermissionColumn)) {
      problems.push(`header: "${name}" is given twice`);
    } else {
      columns.set(name as PermissionColumn, index);
    }
  });

  if (!columns.has('ticket_code')) {
    problems.push('header: missing required column "ticket_code"');
  }

  if (!PERMISSION_FIELDS.some((field) => columns.has(field))) {
    problems.push(
      `header: names no permission column; give at least one of ${PERMISSION_FIELDS.join(', ')}`,
    );
  }

  return columns;
};

/**
 * Reads the permissions file into validated rows.
 *
 * Every row is checked, and every problem collected, before anything is
 * returned. Codes must be volunteer codes; whether each one exists is
 * {@link planPermissions}' job.
 *
 * Every cell is also refused if it starts with a character a spreadsheet reads
 * as a formula. Each column has a fixed shape that would mostly refuse such a
 * value anyway, but a leading tab or CR is trimmed away before the shape is
 * checked, so the cell is tested as written.
 *
 * @param source - The file's contents.
 */
export const parsePermissionsCsv = (source: string): ParsedPermissions => {
  const problems: string[] = [];
  const read = readRecords(source);

  if ('problem' in read) return { rows: [], problems: [read.problem] };

  const [header, ...body] = read.records;

  if (!header) return { rows: [], problems: ['file: is empty'] };

  const columns = readHeader(header.cells, problems);

  if (problems.length > 0) return { rows: [], problems };

  if (body.length === 0) {
    return { rows: [], problems: ['file: has a header and no rows'] };
  }

  const rows: PermissionRow[] = [];
  const firstLineOf = new Map<string, number>();

  for (const { line, cells } of body) {
    const cell = (column: PermissionColumn): string => {
      const index = columns.get(column);

      return index === undefined ? '' : (cells[index] ?? '').trim();
    };

    const before = problems.length;
    let at = `line ${String(line)}`;
    let ticketCode: string | undefined;

    /** Records a problem if a cell would open as a formula. */
    const refuseFormula = (column: PermissionColumn): boolean => {
      const index = columns.get(column);

      if (index === undefined || !startsLikeFormula(cells[index] ?? '')) {
        return false;
      }

      problems.push(
        `${at}: ${column} starts with a character spreadsheets read as a formula (= + - @, tab or CR)`,
      );

      return true;
    };

    if (refuseFormula('ticket_code')) continue;

    try {
      ticketCode = readTypedTicketCode(cell('ticket_code'), 'volunteer');
    } catch {
      problems.push(`${at}: ticket_code is not a volunteer code`);
    }

    if (ticketCode !== undefined) {
      at = `${at} (${ticketCode})`;

      const first = firstLineOf.get(ticketCode);

      if (first === undefined) {
        firstLineOf.set(ticketCode, line);
      } else {
        problems.push(`${at}: duplicate of line ${String(first)}`);
      }
    }

    const values: Partial<PermissionValues> = {};

    for (const field of PERMISSION_FIELDS) {
      if (!columns.has(field) || refuseFormula(field)) continue;

      try {
        if (field === 'redeem_scopes') {
          values.redeem_scopes = readScopes(cell(field));
        } else if (field === 'admin_username') {
          values.admin_username = readAdminUsername(cell(field));
        } else {
          values[field] = readFlag(field, cell(field));
        }
      } catch (err) {
        problems.push(
          `${at}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (problems.length > before || ticketCode === undefined) continue;

    rows.push({ line, ticketCode, values });
  }

  return { rows, problems };
};

/**
 * Decides what loading the file would change.
 *
 * `existing` must hold every row whose code the file uses, under any event.
 * Refused, as problems: a code nobody holds, a code another event holds, and a
 * code held by anyone but a volunteer. An archived volunteer is written and
 * flagged, since an archive can be undone in the editor.
 *
 * An `admin_username` no account holds is refused. One whose account is
 * disabled is written and warned about, since the account can be re-enabled.
 *
 * @param rows - Validated rows, codes unique.
 * @param existing - Rows read back as described above.
 * @param eventId - The event being loaded.
 * @param admins - Every administrator account.
 */
export const planPermissions = (
  rows: readonly PermissionRow[],
  existing: readonly ExistingVolunteer[],
  eventId: string,
  admins: KnownAdmins,
): PermissionPlan => {
  const byCode = new Map(existing.map((row) => [row.ticket_code, row]));
  const plan: PermissionPlan = {
    updates: [],
    unchanged: 0,
    warnings: [],
    problems: [],
  };

  for (const row of rows) {
    const current = byCode.get(row.ticketCode);
    const at = `line ${String(row.line)} (${row.ticketCode})`;

    if (!current) {
      plan.problems.push(`${at}: no attendee holds this code`);
      continue;
    }

    if (current.event_id !== eventId) {
      plan.problems.push(`${at}: code is issued under another event`);
      continue;
    }

    if (current.attendee_role !== 'volunteer') {
      plan.problems.push(`${at}: is not a volunteer`);
      continue;
    }

    const username = row.values.admin_username;

    if (username) {
      const admin = admins.get(username);

      if (!admin) {
        plan.problems.push(`${at}: admin_username matches no administrator`);
        continue;
      }

      if (!admin.isActive) {
        plan.warnings.push(`${at}: administrator account is disabled`);
      }
    }

    const before: PermissionValues = {
      can_redeem: current.can_redeem,
      redeem_scopes: inItemOrder(current.redeem_scopes),
      can_draw: current.can_draw,
      show_admin_link: current.show_admin_link,
      admin_username: current.admin_username,
    };

    const changed = PERMISSION_FIELDS.filter((field) => {
      const next = row.values[field];

      if (next === undefined) return false;
      if (Array.isArray(next)) {
        return next.toString() !== before.redeem_scopes.toString();
      }

      return next !== before[field];
    });

    if (changed.length === 0) {
      plan.unchanged += 1;
      continue;
    }

    const after = { ...before, ...row.values };
    const couldRecord = before.can_redeem ? before.redeem_scopes : [];
    const canRecord = after.can_redeem ? after.redeem_scopes : [];

    const revoked =
      (before.can_draw && !after.can_draw) ||
      couldRecord.some((item) => !canRecord.includes(item));

    plan.updates.push({
      row,
      attendeeId: current.attendee_id,
      changed,
      before,
      revoked,
      archived: current.archived_at !== null,
    });
  }

  return plan;
};
