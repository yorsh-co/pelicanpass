/**
 * Writes a synthetic roster CSV for the load-test stack to stdout.
 *
 * Usage, from the repo root, against the load-test stack only:
 *
 *   node scripts/loadtest/roster.ts > .ignore/loadtest-roster.csv
 *   docker compose -f compose.loadtest.yml --profile tools run --rm -T migrate \
 *     node scripts/db/import-attendees.ts < .ignore/loadtest-roster.csv
 *
 * Options: `--participants <n>` (default 500) and `--volunteers <n>` (default
 * 200), each at most {@link MAX_PER_ROLE}.
 *
 * Every code starts with {@link SYNTHETIC_PREFIX}, which is how
 * `prepare.sql` tells synthetic rows from real ones and refuses to touch a
 * database holding anything else. Phones are derived from the index, so the
 * verification code (the phone's last four digits) never needs to leave the
 * database — `prepare.sql` reads it back into the k6 fixtures.
 *
 * Each attendee gets the first approved option for every item, so every
 * redemption the load test makes is an entitled one.
 */

import { argv, exit, stdout } from 'node:process';

import { ITEM_OPTIONS } from '../../src/modules/admin/admin.item-options.ts';
import { VOLUNTEER_TICKET_PREFIX } from '../../src/constants/ticket.ts';

/** Marks a code as synthetic. Two characters leave three for the index. */
const SYNTHETIC_PREFIX = 'lt';

/**
 * Pads a participant code to the six characters a ticket code needs. The
 * volunteer prefix already supplies the length for volunteers.
 */
const PARTICIPANT_FILL = '0';

/** Three base-36 characters after the prefix. */
const MAX_PER_ROLE = 36 ** 3;

const HEADER =
  'ticket_code,name,phone,role,meal_option,drink_option,tshirt_size';

/**
 * Reads a numeric `--name <n>` option.
 *
 * @param name - Option name, without the dashes.
 * @param fallback - Value when the option is absent.
 */
const option = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);

  if (at === -1) return fallback;

  const value = Number(argv[at + 1]);

  if (!Number.isInteger(value) || value < 0 || value > MAX_PER_ROLE) {
    console.error(
      `--${name} must be an integer from 0 to ${String(MAX_PER_ROLE)}`,
    );
    exit(1);
  }

  return value;
};

/**
 * Builds one roster line.
 *
 * @param index - Position within its role, from zero.
 * @param volunteer - Whether the row is a volunteer.
 */
const row = (index: number, volunteer: boolean): string => {
  const suffix = index.toString(36).padStart(3, '0');
  const code = volunteer
    ? `${VOLUNTEER_TICKET_PREFIX}${SYNTHETIC_PREFIX}${suffix}`
    : `${SYNTHETIC_PREFIX}${PARTICIPANT_FILL}${suffix}`;

  // 55 + area code 11 + a nine-digit mobile. The role digit keeps participant
  // and volunteer numbers apart; the last six are the index.
  const phone = `55119${volunteer ? '2' : '1'}0${String(index).padStart(6, '0')}`;

  const name = `${volunteer ? 'Voluntario' : 'Participante'} Carga ${String(index)}`;

  return [
    code,
    name,
    phone,
    volunteer ? 'volunteer' : 'participant',
    ITEM_OPTIONS.meal[0] ?? '',
    ITEM_OPTIONS.drink[0] ?? '',
    ITEM_OPTIONS.tshirt[0] ?? '',
  ].join(',');
};

const participants = option('participants', 500);
const volunteers = option('volunteers', 200);

const lines = [HEADER];

for (let i = 0; i < participants; i++) lines.push(row(i, false));
for (let i = 0; i < volunteers; i++) lines.push(row(i, true));

stdout.write(`${lines.join('\n')}\n`);
