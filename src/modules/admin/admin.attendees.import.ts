import { CsvError, parse } from 'csv-parse/sync';

import {
  readCheckinTime,
  readLabel,
  readName,
  readPhone,
  readRole,
  readTypedTicketCode,
} from './admin.attendees.rules.ts';
import { OPTION_MAX_LENGTH, isApprovedOption } from './admin.item-options.ts';

import { startsLikeFormula } from '../../constants/csv.ts';
import { isVolunteerOnlyItem } from '../../constants/pass.ts';
import {
  WALK_IN_TICKET_PREFIX,
  VOLUNTEER_TICKET_PREFIX,
} from '../../constants/ticket.ts';

import type { RedemptionItem } from '../../constants/pass.ts';
import type { AttendeeEntry, AttendeeRole } from '../../types/attendee.ts';

/**
 * Reading the sign-up system's roster CSV, and deciding what loading it would
 * change.
 *
 * Pure: nothing here touches the database. `scripts/db/import-attendees.ts`
 * reads the rows this plan needs and writes what it decides, so every rule is
 * testable without a Postgres.
 *
 * **`ticket_code` is the identity.** Loading the same roster twice changes
 * nothing, and loading a corrected one updates only the registration fields
 * that differ — never check-in state, redemptions, a nickname, the archive
 * flag, volunteer permissions or the entry-link token.
 *
 * **A volunteer's `team`, `team_role` and `checkin_time` are registration
 * fields, loaded here.** Unlike the option columns, where an absent header
 * reads as blank, a header that leaves one of these out means the column is not
 * touched; under a present header a blank cell clears the value.
 *
 * **Problems and warnings carry line numbers and ticket codes, never a name or
 * a phone number**, so a report can be pasted into a chat without leaking the
 * roster. That includes csv-parse's own messages, which can quote a cell and
 * are therefore reduced to their code.
 */

/** Every header the roster may carry, in the order the documentation lists. */
export const ROSTER_COLUMNS = [
  'ticket_code',
  'name',
  'phone',
  'role',
  'meal_option',
  'drink_option',
  'tshirt_size',
  'lunch_option',
  'tshirt_volunteer_size',
  'team',
  'team_role',
  'checkin_time',
] as const;

type RosterColumn = (typeof ROSTER_COLUMNS)[number];

/** Headers a roster cannot do without. The rest may be absent or blank. */
const REQUIRED_COLUMNS: readonly RosterColumn[] = [
  'ticket_code',
  'name',
  'phone',
];

/** Which entitlement each option column carries. */
const OPTION_COLUMNS = [
  { column: 'meal_option', item: 'meal' },
  { column: 'drink_option', item: 'drink' },
  { column: 'tshirt_size', item: 'tshirt' },
  { column: 'lunch_option', item: 'lunch' },
  { column: 'tshirt_volunteer_size', item: 'tshirt_volunteer' },
] as const satisfies readonly { column: RosterColumn; item: RedemptionItem }[];

/** The volunteer-only fields a roster may leave out of its header entirely. */
export type VolunteerField = 'team' | 'team_role' | 'checkin_time';

/** The registration fields an import may write, by column name. */
export type ImportField =
  | 'attendee_name'
  | 'attendee_phone'
  | 'meal_option'
  | 'drink_option'
  | 'tshirt_size'
  | 'lunch_option'
  | 'tshirt_volunteer_size'
  | VolunteerField;

/** One roster line, validated and normalised to what would be stored. */
export interface RosterRow {
  /** Line in the file the record ends on, for messages. */
  line: number;
  ticketCode: string;
  role: AttendeeRole;
  /**
   * A {@link VolunteerField} is `undefined` when the header does not name its
   * column, and `null` when it does and the cell is blank.
   */
  fields: Record<Exclude<ImportField, VolunteerField>, string | null> &
    Partial<Record<VolunteerField, string | null>> & {
      attendee_name: string;
      attendee_phone: string;
    };
}

/** The outcome of reading a roster file. */
export interface ParsedRoster {
  rows: RosterRow[];
  /** Anything that makes the file unloadable. */
  problems: string[];
  /** Anything worth a look that does not stop the load. */
  warnings: string[];
}

/** An attendee row as the import reads it back, across every event. */
export type ExistingAttendee = Pick<
  AttendeeEntry,
  | 'attendee_id'
  | 'event_id'
  | 'ticket_code'
  | 'attendee_role'
  | 'checkin_complete'
  | 'archived_at'
  | 'meal_redeemed_at'
  | 'drink_redeemed_at'
  | 'tshirt_redeemed_at'
  | 'lunch_redeemed_at'
  | 'tshirt_volunteer_redeemed_at'
  | ImportField
>;

/** One existing attendee whose registration fields the roster changes. */
export interface PlannedUpdate {
  row: RosterRow;
  attendeeId: string;
  changed: ImportField[];
  checkedIn: boolean;
  archived: boolean;
}

/** What loading a roster would do. */
export interface ImportPlan {
  inserts: RosterRow[];
  updates: PlannedUpdate[];
  unchanged: number;
  /** Codes under this event that the roster no longer lists. Never acted on. */
  missing: string[];
  problems: string[];
}

/** Which `*_redeemed_at` column records collection of each option column. */
const REDEEMED_AT = {
  meal_option: 'meal_redeemed_at',
  drink_option: 'drink_redeemed_at',
  tshirt_size: 'tshirt_redeemed_at',
  lunch_option: 'lunch_redeemed_at',
  tshirt_volunteer_size: 'tshirt_volunteer_redeemed_at',
} as const;

const IMPORT_FIELDS: readonly ImportField[] = [
  'attendee_name',
  'attendee_phone',
  'meal_option',
  'drink_option',
  'tshirt_size',
  'lunch_option',
  'tshirt_volunteer_size',
  'team',
  'team_role',
  'checkin_time',
];

/** Columns whose absence from the header means "not touched". */
const VOLUNTEER_COLUMNS = [
  'team',
  'team_role',
  'checkin_time',
] as const satisfies readonly VolunteerField[];

/**
 * Splits the file into records, each tagged with its line.
 *
 * @param source - The file's contents.
 * @returns The records, header included, or the problem that stopped parsing.
 */
export const readRecords = (
  source: string,
): { records: { line: number; cells: string[] }[] } | { problem: string } => {
  const lines: number[] = [];

  try {
    const records = parse(source, {
      bom: true,
      skip_empty_lines: true,
      on_record: (record: string[], context) => {
        lines.push(context.lines);

        return record;
      },
    });

    return {
      records: records.map((cells, index) => ({
        line: lines[index] ?? 0,
        cells,
      })),
    };
  } catch (err) {
    if (err instanceof CsvError) {
      const line =
        typeof err.lines === 'number' ? `line ${String(err.lines)}` : 'file';

      return { problem: `${line}: malformed CSV (${err.code})` };
    }

    throw err;
  }
};

/**
 * Maps each known header to its cell index.
 *
 * @param header - The first record.
 * @param problems - Appended to in place.
 */
const readHeader = (
  header: readonly string[],
  problems: string[],
): Map<RosterColumn, number> => {
  const columns = new Map<RosterColumn, number>();

  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();

    if (!(ROSTER_COLUMNS as readonly string[]).includes(name)) {
      problems.push(
        `header: unknown column "${name}"; columns are ${ROSTER_COLUMNS.join(', ')}`,
      );
    } else if (columns.has(name as RosterColumn)) {
      problems.push(`header: "${name}" is given twice`);
    } else {
      columns.set(name as RosterColumn, index);
    }
  });

  for (const column of REQUIRED_COLUMNS) {
    if (!columns.has(column)) {
      problems.push(`header: missing required column "${column}"`);
    }
  }

  return columns;
};

/**
 * Runs one field rule, turning its refusal into a problem line.
 *
 * @param at - Prefix naming the line, and the code once known.
 * @param problems - Appended to in place.
 * @param read - The rule to apply.
 * @returns The rule's result, or `undefined` if it refused.
 */
const attempt = <T>(
  at: string,
  problems: string[],
  read: () => T,
): T | undefined => {
  try {
    return read();
  } catch (err) {
    problems.push(`${at}: ${err instanceof Error ? err.message : String(err)}`);

    return undefined;
  }
};

/**
 * Reads the roster file into validated rows.
 *
 * Every row is checked, and every problem collected, before anything is
 * returned — one run reports the whole file rather than its first mistake.
 *
 * The field rules are the editor's, from `admin.attendees.rules.ts`, with one
 * deliberate difference: an option value off the approved list is a warning
 * rather than a refusal. The editor already accepts a stored off-list value
 * because "the roster is imported outside this application and can carry
 * values the list does not"; this is where those values come from.
 *
 * A blank `role` is taken from the code's prefix — `v` for a volunteer,
 * anything else a participant — which is the same pairing
 * `readTypedTicketCode` enforces when a role is given.
 *
 * Free-text cells (`name`, the option columns, `team` and `team_role`) that
 * start with a character a spreadsheet reads as a formula are refused: these
 * values reach `export-results.sql` and the exports verbatim. `phone` is
 * exempt, since only its digits are kept and a leading `+` is normal, and
 * `ticket_code`, `role` and `checkin_time` are held to a fixed shape.
 *
 * A participant with a volunteer-only item (`lunch_option`,
 * `tshirt_volunteer_size`) or a non-blank `team`, `team_role` or
 * `checkin_time` is a problem. Those three are left off the row when the
 * header does not name them.
 *
 * @param source - The file's contents.
 */
export const parseRosterCsv = (source: string): ParsedRoster => {
  const problems: string[] = [];
  const warnings: string[] = [];
  const read = readRecords(source);

  if ('problem' in read)
    return { rows: [], problems: [read.problem], warnings };

  const [header, ...body] = read.records;

  if (!header) return { rows: [], problems: ['file: is empty'], warnings };

  const columns = readHeader(header.cells, problems);

  if (problems.length > 0) return { rows: [], problems, warnings };

  if (body.length === 0) {
    return { rows: [], problems: ['file: has a header and no rows'], warnings };
  }

  const rows: RosterRow[] = [];
  const firstLineOf = new Map<string, number>();

  for (const { line, cells } of body) {
    const cell = (column: RosterColumn): string => {
      const index = columns.get(column);

      return index === undefined ? '' : (cells[index] ?? '').trim();
    };

    const raw = (column: RosterColumn): string => {
      const index = columns.get(column);

      return index === undefined ? '' : (cells[index] ?? '');
    };

    const rawCode = cell('ticket_code').toLowerCase();
    const rawRole = cell('role').toLowerCase();
    const before = problems.length;
    let at = `line ${String(line)}`;

    const role = attempt(at, problems, () =>
      rawRole === ''
        ? rawCode.startsWith(VOLUNTEER_TICKET_PREFIX)
          ? 'volunteer'
          : 'participant'
        : readRole(rawRole),
    );

    const ticketCode =
      role === undefined
        ? undefined
        : attempt(at, problems, () => readTypedTicketCode(rawCode, role));

    if (ticketCode !== undefined) {
      at = `${at} (${ticketCode})`;

      if (ticketCode.startsWith(WALK_IN_TICKET_PREFIX)) {
        problems.push(
          `${at}: "${WALK_IN_TICKET_PREFIX}" codes are issued by the attendees editor, not the roster`,
        );
      }

      const first = firstLineOf.get(ticketCode);

      if (first === undefined) {
        firstLineOf.set(ticketCode, line);
      } else {
        problems.push(`${at}: duplicate of line ${String(first)}`);
      }
    }

    /** Records a problem if a free-text cell would open as a formula. */
    const refuseFormula = (column: RosterColumn): boolean => {
      if (!startsLikeFormula(raw(column))) return false;

      problems.push(
        `${at}: ${column} starts with a character spreadsheets read as a formula (= + - @, tab or CR)`,
      );

      return true;
    };

    refuseFormula('name');

    const name = attempt(at, problems, () => readName(cell('name')));
    const phone = attempt(at, problems, () => readPhone(cell('phone')));

    const options = {} as Record<
      (typeof OPTION_COLUMNS)[number]['column'],
      string | null
    >;

    for (const { column, item } of OPTION_COLUMNS) {
      const value = cell(column);

      if (refuseFormula(column)) {
        options[column] = null;
        continue;
      }

      if (value.length > OPTION_MAX_LENGTH) {
        problems.push(
          `${at}: ${column} is longer than ${String(OPTION_MAX_LENGTH)} characters`,
        );
      } else if (
        value !== '' &&
        role !== undefined &&
        !isApprovedOption(item, value, role)
      ) {
        warnings.push(
          `${at}: ${column} "${value}" is not on the approved list`,
        );
      }

      options[column] = value === '' ? null : value;

      // The item's `attendees_*_volunteer_check` would refuse it at load time
      // anyway; caught here so the report names the line.
      if (value !== '' && role === 'participant' && isVolunteerOnlyItem(item)) {
        problems.push(`${at}: ${column} is for volunteers only`);
      }
    }

    const volunteer: Partial<Record<VolunteerField, string | null>> = {};

    for (const column of VOLUNTEER_COLUMNS) {
      if (!columns.has(column)) continue;

      if (column !== 'checkin_time' && refuseFormula(column)) continue;

      const value = cell(column);

      if (value === '') {
        volunteer[column] = null;
      } else if (role === 'participant') {
        problems.push(`${at}: ${column} is for volunteers only`);
      } else {
        const read = attempt(at, problems, () =>
          column === 'checkin_time'
            ? readCheckinTime(value)
            : readLabel(column, value),
        );

        if (read !== undefined) volunteer[column] = read;
      }
    }

    if (
      problems.length > before ||
      role === undefined ||
      ticketCode === undefined ||
      name === undefined ||
      phone === undefined
    ) {
      continue;
    }

    rows.push({
      line,
      ticketCode,
      role,
      fields: {
        attendee_name: name,
        attendee_phone: phone,
        ...options,
        ...volunteer,
      },
    });
  }

  return { rows, problems, warnings };
};

/**
 * Decides what loading the roster would change.
 *
 * `existing` must hold every attendee under `eventId` — that is how codes the
 * roster no longer lists are found — plus any row under another event whose
 * code the roster uses, because `ticket_code` is unique across the whole
 * table.
 *
 * Refused, as problems, rather than written:
 *
 * - **A code another event holds.** Loading it would fail the unique
 *   constraint at best; the other event is not named.
 * - **A changed role.** Migration 016 explains why the role decides the door
 *   window and the raffle; the editor locks it after check-in, and an import,
 *   which nobody reviews row by row, never changes it at all.
 * - **Clearing a collected entitlement.** The editor's own rule: the roster
 *   would say they were never entitled while `redemptions` says they collected
 *   it.
 *
 * A {@link VolunteerField} the row leaves `undefined` — its column was not in
 * the header — is neither compared nor written. A stored `checkin_time` is
 * read back as `HH:MM:SS` and compared on its `HH:MM`.
 *
 * `missing` leaves out `d` codes, which the editor issues and no roster ever
 * lists, and archived rows, which have already been dealt with.
 *
 * @param rows - Validated roster rows, codes unique.
 * @param existing - Rows read back as described above.
 * @param eventId - The event being loaded.
 */
export const planImport = (
  rows: readonly RosterRow[],
  existing: readonly ExistingAttendee[],
  eventId: string,
): ImportPlan => {
  const byCode = new Map(existing.map((row) => [row.ticket_code, row]));
  const listed = new Set(rows.map((row) => row.ticketCode));

  const plan: ImportPlan = {
    inserts: [],
    updates: [],
    unchanged: 0,
    missing: [],
    problems: [],
  };

  for (const row of rows) {
    const current = byCode.get(row.ticketCode);
    const at = `line ${String(row.line)} (${row.ticketCode})`;

    if (!current) {
      plan.inserts.push(row);
      continue;
    }

    if (current.event_id !== eventId) {
      plan.problems.push(`${at}: code is already issued under another event`);
      continue;
    }

    if (current.attendee_role !== row.role) {
      plan.problems.push(
        `${at}: role would change from ${current.attendee_role} to ${row.role}; an import never changes a role`,
      );
      continue;
    }

    const cleared = OPTION_COLUMNS.find(
      ({ column }) =>
        row.fields[column] === null && current[REDEEMED_AT[column]] !== null,
    );

    if (cleared) {
      plan.problems.push(
        `${at}: ${cleared.column} is blank but the ${cleared.item} was already collected`,
      );
      continue;
    }

    const changed = IMPORT_FIELDS.filter((field) => {
      const wanted = row.fields[field];

      if (wanted === undefined) return false;

      const stored =
        field === 'checkin_time'
          ? (current.checkin_time?.slice(0, 5) ?? null)
          : current[field];

      return wanted !== stored;
    });

    if (changed.length === 0) {
      plan.unchanged += 1;
      continue;
    }

    plan.updates.push({
      row,
      attendeeId: current.attendee_id,
      changed,
      checkedIn: current.checkin_complete,
      archived: current.archived_at !== null,
    });
  }

  plan.missing = existing
    .filter(
      (row) =>
        row.event_id === eventId &&
        row.archived_at === null &&
        !row.ticket_code.startsWith(WALK_IN_TICKET_PREFIX) &&
        !listed.has(row.ticket_code),
    )
    .map((row) => row.ticket_code)
    .sort();

  return plan;
};
