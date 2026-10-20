/**
 * Fills a development database with a test roster.
 *
 * Usage:
 *   docker compose exec app node scripts/db/seed.ts --reset
 *   docker compose exec app node scripts/db/seed.ts --count 80 --checked-in 30
 *
 * The `prod` image ships no `scripts/db`, so on the production stack run it
 * through `migrate`. It needs `--force` there; never pass that against the
 * event's own database. See docs/operations/db-cheatsheet.md.
 *   docker compose run --rm --build migrate node scripts/db/seed.ts --reset --force
 *
 * Connects as the migrator role. The application role holds no `DELETE` on
 * `attendees`, and migrations 008, 010 and 011 grant it `SELECT` on
 * `can_redeem`, `redeem_scopes` and `can_draw` while deliberately withholding
 * `UPDATE` — so the permission spread this script exists to produce cannot be
 * written through the application pool at all. See scripts/admin/db.ts.
 *
 * Every seeded ticket code carries {@link SEED_MARKER}, which is what makes
 * `--reset` safe to hand to anyone: the delete is scoped to that marker and to
 * the current event, so it cannot reach a row the real roster put there.
 *
 * It also upserts the {@link SEED_ADMINS} the volunteers link to, since three
 * of the access tiers are derived from a linked administrator's scopes.
 */

import { argv, env as processEnv, exit } from 'node:process';

import { db } from '../admin/db.ts';

import {
  isValidTicketCode,
  VOLUNTEER_TICKET_PREFIX,
} from '../../src/constants/ticket.ts';
import { ITEM_OPTIONS } from '../../src/modules/admin/admin.item-options.ts';

import type { AdminScope } from '../../src/constants/admin-scopes.ts';

/**
 * Marks a ticket code as this script's to delete.
 *
 * Three characters, extending the `t3st1` convention `docs/operations/db-cheatsheet.md`
 * already uses by hand. It leaves two characters of the five after a code's
 * key or prefix for the index, which is what caps a run at {@link MAX_SEEDED}.
 */
const SEED_MARKER = 't3s';

/** One-character key that makes a seeded participant code a keyed code. */
const PARTICIPANT_KEY = 's';

/** Ceiling on either population, set by the two digits the marker leaves. */
const MAX_SEEDED = 100;

/** Every scope the `attendees_redeem_scopes_check` constraint admits. */
const ALL_REDEEM_SCOPES = [
  'tshirt',
  'meal',
  'drink',
  'lunch',
  'tshirt_volunteer',
];

/** The sequence `checkin_number` is drawn from, as migration 001 names it. */
const CHECKIN_SEQUENCE = 'checkin_number_seq';

/** Minutes between one seeded check-in and the next, working backwards. */
const CHECKIN_SPACING_MINUTES = 8;

/**
 * Leading digits every seeded phone number carries.
 *
 * The four digits appended to it are the verification code the attendee types
 * at step two, because that step compares against the last four of this column.
 * Making them derivable from the ticket code is the point: a test check-in
 * needs no `SELECT` to get past the second screen.
 */
const PHONE_PREFIX = '551190000';

/** Added to a participant's index to form its verification code. */
const PARTICIPANT_CODE_BASE = 1000;

/** Added to a volunteer's index to form its verification code. */
const VOLUNTEER_CODE_BASE = 2000;

/**
 * Administrator accounts seeded volunteers link to through `admin_username`.
 *
 * They exist so the scope-derived tiers have something to derive from, and
 * carry no usable password: {@link UNUSABLE_PASSWORD_HASH} verifies against
 * nothing. `scripts/admin/set-admin-password.ts` makes one usable. Not removed
 * by `--reset`, because administrators are not event-scoped; re-running the
 * script restores their scopes and re-enables them instead.
 */
const SEED_ADMINS = {
  edit: {
    username: `${SEED_MARKER}-edit`,
    scopes: ['attendees:read', 'attendees:write'],
  },
  lookup: {
    username: `${SEED_MARKER}-lookup`,
    scopes: ['attendees:read', 'checkin:write'],
  },
  tshirt: {
    username: `${SEED_MARKER}-tshirt`,
    scopes: ['tshirt:redeem'],
  },
} as const satisfies Record<
  string,
  { username: string; scopes: readonly AdminScope[] }
>;

/** Not a hash `admin.password.ts` can parse, so every login against it fails. */
const UNUSABLE_PASSWORD_HASH = '!';

/** Every third checked-in participant is given a nickname. */
const NICKNAME_EVERY = 3;

const FIRST_NAMES = [
  'Ana',
  'Bruno',
  'Camila',
  'Diego',
  'Eduarda',
  'Felipe',
  'Gabriela',
  'Henrique',
  'Isabela',
  'João',
  'Larissa',
  'Mateus',
  'Natália',
  'Otávio',
  'Priscila',
  'Rafael',
  'Sabrina',
  'Thiago',
  'Vanessa',
  'Wesley',
];

const LAST_NAMES = [
  'Almeida',
  'Barbosa',
  'Carvalho',
  'Duarte',
  'Esteves',
  'Ferreira',
  'Gonçalves',
  'Henriques',
  'Iglesias',
  'Justino',
  'Lima',
  'Moreira',
  'Nogueira',
  'Oliveira',
  'Pereira',
  'Queiroz',
  'Ribeiro',
  'Santos',
  'Teixeira',
  'Vasconcelos',
];

const NICKNAMES = ['Aninha', 'Bru', 'Cacá', 'Dedé', 'Duda', 'Gabi', 'Tuca'];

/**
 * What a seeded volunteer is permitted to do.
 *
 * A fixed table rather than anything random: the staff surface gates on these
 * three columns together, and a spread that changes between runs cannot be used
 * to reproduce a bug. Cycled when more volunteers than rows are asked for, so
 * every combination is present from the first ten. The sixth row is the
 * control — a volunteer holding nothing, which the surface must refuse. The
 * fifth also shows the admin link, which makes it the fullest pass the layout
 * has to fit. The last four link a {@link SEED_ADMINS} account, so that with
 * the first six every access tier is shown at least once. The team line covers
 * each case the pass renders: team and role, team only, and neither, which
 * falls back to the welcome. The arrival time is set on most and left unset on
 * two.
 */
const VOLUNTEER_PERMISSIONS = [
  {
    canRedeem: true,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: false,
    showAdminLink: false,
    adminUsername: null,
    team: 'lojinha',
    teamRole: 'caixa',
    checkinTime: '07:30',
  },
  {
    canRedeem: true,
    redeemScopes: ['tshirt'],
    canDraw: false,
    showAdminLink: false,
    adminUsername: null,
    team: 'lojinha',
    teamRole: 'entrega de camisetas',
    checkinTime: '08:00',
  },
  {
    canRedeem: true,
    redeemScopes: ['meal', 'drink'],
    canDraw: false,
    showAdminLink: false,
    adminUsername: null,
    team: 'alimentação',
    teamRole: 'caixa',
    checkinTime: '08:30',
  },
  {
    canRedeem: false,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: true,
    showAdminLink: false,
    adminUsername: null,
    team: 'comunicação',
    teamRole: null,
    checkinTime: null,
  },
  {
    canRedeem: true,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: true,
    showAdminLink: true,
    adminUsername: null,
    team: 'check-in',
    teamRole: 'validação',
    checkinTime: '07:00',
  },
  {
    canRedeem: false,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: false,
    showAdminLink: false,
    adminUsername: null,
    team: null,
    teamRole: null,
    checkinTime: null,
  },
  {
    canRedeem: false,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: false,
    showAdminLink: false,
    adminUsername: SEED_ADMINS.edit.username,
    team: 'secretaria',
    teamRole: 'cadastro',
    checkinTime: '09:00',
  },
  {
    canRedeem: true,
    redeemScopes: ['meal', 'drink'],
    canDraw: false,
    showAdminLink: false,
    adminUsername: SEED_ADMINS.lookup.username,
    team: 'check-in',
    teamRole: 'coordenação',
    checkinTime: '08:00',
  },
  {
    canRedeem: false,
    redeemScopes: ALL_REDEEM_SCOPES,
    canDraw: false,
    showAdminLink: false,
    adminUsername: SEED_ADMINS.lookup.username,
    team: 'check-in',
    teamRole: 'consulta',
    checkinTime: '09:30',
  },
  {
    canRedeem: true,
    redeemScopes: ['tshirt'],
    canDraw: false,
    showAdminLink: false,
    adminUsername: SEED_ADMINS.tshirt.username,
    team: 'lojinha',
    teamRole: 'camisetas',
    checkinTime: '10:00',
  },
];

/** One row as it will be inserted, before `checkin_number` is drawn. */
interface SeedRow {
  event_id: string;
  ticket_code: string;
  attendee_name: string;
  attendee_nickname: string | null;
  attendee_phone: string;
  attendee_role: 'participant' | 'volunteer';
  can_redeem: boolean;
  redeem_scopes: string[];
  can_draw: boolean;
  show_admin_link: boolean;
  admin_username: string | null;
  team: string | null;
  team_role: string | null;
  checkin_time: string | null;
  checkin_complete: boolean;
  checkin_at: Date | null;
  archived_at: Date | null;
  meal_option: string | null;
  drink_option: string | null;
  tshirt_size: string | null;
  lunch_option: string | null;
  tshirt_volunteer_size: string | null;
}

/**
 * Columns carried as bound parameters, in the order the `INSERT` names them.
 *
 * `checkin_number` is absent because it is not a parameter: it is either
 * `nextval(…)` or `NULL`, appended per row by {@link buildValues}.
 */
const COLUMNS: (keyof SeedRow)[] = [
  'event_id',
  'ticket_code',
  'attendee_name',
  'attendee_nickname',
  'attendee_phone',
  'attendee_role',
  'can_redeem',
  'redeem_scopes',
  'can_draw',
  'show_admin_link',
  'admin_username',
  'team',
  'team_role',
  'checkin_time',
  'checkin_complete',
  'checkin_at',
  'archived_at',
  'meal_option',
  'drink_option',
  'tshirt_size',
  'lunch_option',
  'tshirt_volunteer_size',
];

/**
 * Reads a `--flag value` pair from the command line.
 *
 * @param name - Flag name, without the dashes.
 * @returns The value, or `undefined` if the flag is absent.
 */
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);

  if (index === -1) return undefined;

  return argv[index + 1];
};

/**
 * Reads a `--flag` switch.
 *
 * @param name - Flag name, without the dashes.
 */
const switched = (name: string): boolean => argv.includes(`--${name}`);

/**
 * Reads a population size from the command line.
 *
 * @param name - Flag name, without the dashes.
 * @param fallback - Value to use when the flag is absent.
 * @throws {Error} If the value is not a whole number within range.
 */
const size = (name: string, fallback: number): number => {
  const raw = flag(name);

  if (raw === undefined) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || value > MAX_SEEDED) {
    throw new Error(
      `--${name} must be a whole number between 0 and ${String(MAX_SEEDED)}`,
    );
  }

  return value;
};

/**
 * Selects from a pool by index, wrapping when the index runs past the end.
 *
 * The `undefined` branch is unreachable — the modulo keeps the index in range —
 * but `noUncheckedIndexedAccess` types the access as optional, and a throw
 * documents the invariant better than a non-null assertion.
 *
 * @param pool - Values to choose from, never empty.
 * @param index - Position, of any size.
 */
const pick = <T>(pool: readonly T[], index: number): T => {
  const value = pool[index % pool.length];

  if (value === undefined) throw new Error('Cannot pick from an empty pool');

  return value;
};

/**
 * Builds the ticket code for a seeded attendee.
 *
 * @param index - Position within its population, below {@link MAX_SEEDED}.
 * @param role - Which population it belongs to.
 * @throws {Error} If the result is not a shape the check-in flow accepts.
 */
const ticketCodeFor = (
  index: number,
  role: SeedRow['attendee_role'],
): string => {
  const prefix =
    role === 'volunteer' ? VOLUNTEER_TICKET_PREFIX : PARTICIPANT_KEY;
  const code = `${prefix}${SEED_MARKER}${String(index).padStart(2, '0')}`;

  if (!isValidTicketCode(code)) {
    throw new Error(`Generated an invalid ticket code: ${code}`);
  }

  return code;
};

/**
 * Builds the phone number for a seeded attendee.
 *
 * @param index - Position within its population.
 * @param role - Which population it belongs to, which sets the code base.
 */
const phoneFor = (index: number, role: SeedRow['attendee_role']): string => {
  const base =
    role === 'volunteer' ? VOLUNTEER_CODE_BASE : PARTICIPANT_CODE_BASE;

  return `${PHONE_PREFIX}${String(base + index)}`;
};

/**
 * Builds a two-token name, so the confirmation preview's "first name plus last
 * initial" masking has something to mask.
 *
 * The surname stride is coprime with the pool length, which keeps first and
 * last names from advancing in lockstep and repeating every twenty rows.
 *
 * @param index - Position within its population.
 */
const nameFor = (index: number): string =>
  `${pick(FIRST_NAMES, index)} ${pick(LAST_NAMES, index * 7)}`;

/**
 * Entitlements every seeded attendee carries, so the roster's option columns
 * and the pass both have something to show.
 *
 * @param index - Position within its population.
 */
const optionsFor = (
  index: number,
): Pick<SeedRow, 'meal_option' | 'drink_option' | 'tshirt_size'> => ({
  meal_option: pick(ITEM_OPTIONS.meal, index),
  drink_option: pick(ITEM_OPTIONS.drink, index * 2),
  tshirt_size: pick(ITEM_OPTIONS.tshirt, index * 3),
});

/** How the roster is to be shaped. */
interface SeedPlan {
  eventId: string;
  participants: number;
  volunteers: number;
  checkedIn: number;
  archived: number;
}

/**
 * Builds the participant rows.
 *
 * The first `checkedIn` are through check-in, backdated so that they are spaced
 * rather than simultaneous — the roster orders on `checkin_at` and the metrics
 * panel buckets by minute, and a roster where every row shares one timestamp
 * exercises neither. The last `archived` are soft-retired, which is what gives
 * the `archived_at IS NULL` filter on every read path something to exclude.
 *
 * @param plan - The requested shape.
 * @param now - Epoch milliseconds the backdating counts back from.
 */
const participantRows = (plan: SeedPlan, now: number): SeedRow[] =>
  Array.from({ length: plan.participants }, (_, index) => {
    const checkedIn = index < plan.checkedIn;
    const nicknamed = checkedIn && index % NICKNAME_EVERY === 0;
    const minutesAgo = (plan.checkedIn - index) * CHECKIN_SPACING_MINUTES;
    const archived = index >= plan.participants - plan.archived;

    return {
      event_id: plan.eventId,
      ticket_code: ticketCodeFor(index, 'participant'),
      attendee_name: nameFor(index),
      attendee_nickname: nicknamed ? pick(NICKNAMES, index) : null,
      attendee_phone: phoneFor(index, 'participant'),
      attendee_role: 'participant',
      can_redeem: false,
      redeem_scopes: ALL_REDEEM_SCOPES,
      can_draw: false,
      show_admin_link: false,
      admin_username: null,
      team: null,
      team_role: null,
      checkin_time: null,
      checkin_complete: checkedIn,
      checkin_at: checkedIn ? new Date(now - minutesAgo * 60_000) : null,
      archived_at: archived ? new Date(now) : null,
      ...optionsFor(index),
      lunch_option: null,
      tshirt_volunteer_size: null,
    } satisfies SeedRow;
  });

/**
 * Builds the volunteer rows, cycling {@link VOLUNTEER_PERMISSIONS}.
 *
 * Every other one has lunch and two in three have a volunteer t-shirt, so
 * both the entitled and the not-entitled volunteer card exist for each;
 * participants never have either.
 *
 * None is checked in and none carries a `checkin_number`. That is not an
 * omission: the raffle draws from every completed check-in, so a volunteer
 * holding a number would put staff into the attendees' raffle pool.
 *
 * @param plan - The requested shape.
 */
const volunteerRows = (plan: SeedPlan): SeedRow[] =>
  Array.from({ length: plan.volunteers }, (_, index) => {
    const permissions = pick(VOLUNTEER_PERMISSIONS, index);

    return {
      event_id: plan.eventId,
      ticket_code: ticketCodeFor(index, 'volunteer'),
      attendee_name: nameFor(index + FIRST_NAMES.length / 2),
      attendee_nickname: null,
      attendee_phone: phoneFor(index, 'volunteer'),
      attendee_role: 'volunteer',
      can_redeem: permissions.canRedeem,
      redeem_scopes: permissions.redeemScopes,
      can_draw: permissions.canDraw,
      show_admin_link: permissions.showAdminLink,
      admin_username: permissions.adminUsername,
      team: permissions.team,
      team_role: permissions.teamRole,
      checkin_time: permissions.checkinTime,
      checkin_complete: false,
      checkin_at: null,
      archived_at: null,
      ...optionsFor(index),
      lunch_option: index % 2 === 0 ? pick(ITEM_OPTIONS.lunch, index) : null,
      tshirt_volunteer_size:
        index % 3 === 0 ? null : pick(ITEM_OPTIONS.tshirt_volunteer, index),
    } satisfies SeedRow;
  });

/**
 * Renders the `VALUES` clause and collects the parameters it refers to.
 *
 * `checkin_number` is emitted as SQL rather than bound, because a row that is
 * not checked in must not draw from the sequence at all — binding it would
 * still have meant calling `nextval` for every row.
 *
 * @param rows - Rows to insert.
 * @param params - Parameter array, appended to in place.
 */
const buildValues = (rows: SeedRow[], params: unknown[]): string =>
  rows
    .map((row) => {
      const placeholders = COLUMNS.map((column) => {
        params.push(row[column]);

        return `$${String(params.length)}`;
      });

      placeholders.push(
        row.checkin_complete ? `nextval('${CHECKIN_SEQUENCE}')` : 'NULL',
      );

      return `(${placeholders.join(', ')})`;
    })
    .join(',\n      ');

/**
 * The two `LIKE` patterns that match everything this script has ever inserted.
 *
 * Both populations, because a keyed code and a `v` code share the marker but
 * not the prefix.
 */
const markerPatterns = (): [string, string] => [
  `${PARTICIPANT_KEY}${SEED_MARKER}%`,
  `${VOLUNTEER_TICKET_PREFIX}${SEED_MARKER}%`,
];

/**
 * Refuses to run against a production database.
 *
 * `src/config/env.ts` treats an unset `NODE_ENV` as production, and so does
 * this: the failure mode of guessing wrong is a deleted roster.
 *
 * @throws {Error} If the environment looks like production and `--force` is absent.
 */
const guardEnvironment = (): void => {
  if (switched('force')) return;

  if ((processEnv.NODE_ENV ?? 'production') === 'production') {
    throw new Error(
      'NODE_ENV is production, or unset and therefore treated as production.\n' +
        '  This script inserts and deletes attendee rows. Pass --force to override.',
    );
  }
};

/**
 * Reads the requested shape off the command line.
 *
 * @throws {Error} If `EVENT_ID` is unset, or a size is out of range.
 */
const readPlan = (): SeedPlan => {
  const eventId = processEnv.EVENT_ID;

  if (!eventId) {
    throw new Error(
      'Missing environment variable: EVENT_ID — every attendee row is scoped to it',
    );
  }

  const plan: SeedPlan = {
    eventId,
    participants: size('count', 40),
    volunteers: size('volunteers', 10),
    checkedIn: size('checked-in', 15),
    archived: size('archived', 2),
  };

  if (plan.checkedIn > plan.participants) {
    throw new Error('--checked-in cannot exceed --count');
  }

  if (plan.archived > plan.participants) {
    throw new Error('--archived cannot exceed --count');
  }

  return plan;
};

/**
 * Reports what was written, and how to check in as one of the rows.
 *
 * @param plan - The requested shape.
 * @param inserted - Rows this run actually wrote.
 * @param skipped - Rows already present, which were left alone.
 */
const report = (plan: SeedPlan, inserted: number, skipped: number): void => {
  console.log(`\n✓ Seeded ${String(inserted)} attendee(s)`);

  if (skipped > 0) {
    console.log(
      `  Skipped ${String(skipped)} already present — re-run with --reset to rebuild`,
    );
  }

  console.log(
    `  ${String(plan.participants)} participants (${String(plan.checkedIn)} checked in, ${String(plan.archived)} archived), ${String(plan.volunteers)} volunteers`,
  );
  console.log(
    `  Codes ${PARTICIPANT_KEY}${SEED_MARKER}00…, ${VOLUNTEER_TICKET_PREFIX}${SEED_MARKER}00… — the verification code is the last four digits of the phone`,
  );
  console.log(
    `  ${PARTICIPANT_KEY}${SEED_MARKER}07 → ${String(PARTICIPANT_CODE_BASE + 7)}, ${VOLUNTEER_TICKET_PREFIX}${SEED_MARKER}01 → ${String(VOLUNTEER_CODE_BASE + 1)}`,
  );
};

const main = async (): Promise<void> => {
  guardEnvironment();

  const plan = readPlan();
  const rows = [...participantRows(plan, Date.now()), ...volunteerRows(plan)];
  const patterns = markerPatterns();

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    if (switched('reset')) {
      const deleted = await client.query(
        `DELETE FROM attendees
        WHERE event_id = $1
          AND (ticket_code LIKE $2 OR ticket_code LIKE $3)`,
        [plan.eventId, ...patterns],
      );

      console.log(
        `\n  Reset: removed ${String(deleted.rowCount ?? 0)} seeded row(s)`,
      );

      // Wind the sequence back, or repeated resets walk the numbers upwards and
      // a roster reseeded three times starts calling the raffle from 91.
      //
      // Rewound to one past the highest number *left in the table* rather than
      // to 1, which `docs/operations/db-cheatsheet.md` reserves for a full `TRUNCATE`.
      // `checkin_number` is `UNIQUE`, so restarting from 1 while a real
      // checked-in row still held number 3 would fail this script's next
      // insert; taken from what survives the delete, a collision is impossible.
      await client.query(
        `SELECT setval(
          '${CHECKIN_SEQUENCE}',
          coalesce((SELECT max(checkin_number) FROM attendees), 0) + 1,
          false
        )`,
      );
    }

    // Checked across every event rather than just this one: `ticket_code` is
    // unique table-wide, so a seeded row left behind under a different
    // `event_id` would collide on insert even though `--reset` deliberately
    // will not reach across events to delete it.
    const present = await client.query<{ ticket_code: string }>(
      `SELECT ticket_code FROM attendees
      WHERE ticket_code LIKE $1 OR ticket_code LIKE $2`,
      patterns,
    );

    for (const { username, scopes } of Object.values(SEED_ADMINS)) {
      await client.query(
        `INSERT INTO admins (username, password_hash, admin_scopes)
        VALUES ($1, $2, $3)
        ON CONFLICT (username) DO UPDATE
          SET admin_scopes = EXCLUDED.admin_scopes,
            is_active = true,
            updated_at = now()`,
        [username, UNUSABLE_PASSWORD_HASH, scopes],
      );
    }

    const existing = new Set(present.rows.map((row) => row.ticket_code));
    const pending = rows.filter((row) => !existing.has(row.ticket_code));

    if (pending.length > 0) {
      const params: unknown[] = [];
      const values = buildValues(pending, params);

      await client.query(
        `INSERT INTO attendees (${COLUMNS.join(', ')}, checkin_number)
        VALUES
      ${values}`,
        params,
      );
    }

    await client.query('COMMIT');

    report(plan, pending.length, rows.length - pending.length);
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);

  exit(1);
} finally {
  await db.end();
}
