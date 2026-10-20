/**
 * Prints ticket codes to paste into a roster CSV before import.
 *
 * The importer only validates codes, it never issues them, so a roster whose
 * sign-up system did not provide them needs codes made up front. These come
 * from the same vowel-free alphabet as the attendees editor.
 *
 *   npm run codes -- <count> [key]
 *   node scripts/db/generate-ticket-codes.ts <count> [key]
 *
 * `count` is 1 to 10,000 and `key` is the one lowercase letter or digit every
 * code starts with, `a` unless given. Codes print one per line on stdout. Use
 * `v` for volunteers. No `.env` is read and no database is touched.
 *
 * Codes are unique within a run only. One that is already on the roster is not
 * refused: the import's change report shows it as an update to that attendee.
 *
 * `d` is refused. It is reserved for walk-ins the attendees editor creates, and
 * the importer rejects every code that starts with it.
 *
 * Any key other than `v` is a participant key, and prints a warning on stderr.
 * If the external sign-up system also issues codes under that key, a later
 * roster may reuse one of these, and the import treats both as the same
 * attendee.
 */
import {
  VOLUNTEER_TICKET_PREFIX,
  WALK_IN_TICKET_PREFIX,
} from '../../src/constants/ticket.ts';
import { buildTicketCode } from '../../src/modules/admin/admin.ticket-code.ts';

/** Key used when none is given. */
const DEFAULT_KEY = 'a';

/** Most codes one run prints. */
const MAX_COUNT = 10_000;

const USAGE = 'usage: npm run codes -- <count> [key]';

/**
 * Generates distinct ticket codes under one key.
 *
 * @param count - How many codes to make, 1 to {@link MAX_COUNT}.
 * @param key - One lowercase letter or digit, other than the walk-in key.
 * @returns `count` codes, distinct within this call.
 * @throws {Error} If the key or the count is not acceptable.
 */
export const generateTicketCodes = (
  count: number,
  key: string = DEFAULT_KEY,
): string[] => {
  if (!/^[a-z0-9]$/.test(key)) {
    throw new Error(`key must be one lowercase letter or digit, got "${key}"`);
  }

  if (key === WALK_IN_TICKET_PREFIX) {
    throw new Error(
      `"${WALK_IN_TICKET_PREFIX}" codes are issued by the attendees editor, not the roster`,
    );
  }

  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`count must be an integer from 1 to ${String(MAX_COUNT)}`);
  }

  const codes = new Set<string>();

  while (codes.size < count) {
    codes.add(buildTicketCode(key));
  }

  return [...codes];
};

/**
 * Reads the command-line arguments after the script path.
 *
 * @param argv - Arguments: the count, then an optional key.
 * @returns The count and the key, which defaults to {@link DEFAULT_KEY}.
 * @throws {Error} If the count is missing or not a whole number, or there are
 *   extra arguments.
 */
export const parseArgs = (
  argv: readonly string[],
): { count: number; key: string } => {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error('expected a count and an optional key');
  }

  const [rawCount = '', key = DEFAULT_KEY] = argv;

  // Digits only: `Number` alone would also take `1e3`, `0x10` and padding.
  if (!/^\d+$/.test(rawCount)) {
    throw new Error(`count must be a whole number, got "${rawCount}"`);
  }

  return { count: Number(rawCount), key };
};

if (import.meta.main) {
  try {
    const { count, key } = parseArgs(process.argv.slice(2));
    const codes = generateTicketCodes(count, key);

    if (key !== VOLUNTEER_TICKET_PREFIX) {
      console.error(
        `warning: "${key}" is a participant key; if the external sign-up system also issues "${key}" codes, a later roster may reuse one of these and the import will treat both as the same attendee`,
      );
    }

    console.log(codes.join('\n'));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    process.exitCode = 1;
  }
}
