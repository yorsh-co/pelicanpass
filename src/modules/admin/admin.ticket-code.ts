/**
 * Ticket code body generation, shared by the attendees editor and the
 * code-generation script (`scripts/db/generate-ticket-codes.ts`).
 *
 * Kept free of database and env imports so the script runs without a configured
 * stack.
 */
import crypto from 'node:crypto';

/**
 * Characters a generated code body is built from.
 *
 * The digits `0` and `1` are left out because they read as `O` and `I`/`L` on a
 * screen. Vowels and the digits `3` and `4` (leetspeak for `e` and `a`) are left
 * out so a code cannot spell a word in any language. `5` and `7` stay: without
 * vowels they cannot form one.
 *
 * This narrows generated codes only. Typed and imported codes may still hold
 * the excluded characters, so the validators are deliberately not narrowed to
 * match. A rule that applied to generated codes alone must not show itself: a
 * walk-in or volunteer code containing any of them is simply unknown, and fails
 * exactly as any other invalid code does.
 */
const TICKET_CODE_ALPHABET = 'bcdfghjklmnpqrstvwxyz256789';

/** Length of the random body that follows the one-character key. */
const TICKET_CODE_BODY_LENGTH = 5;

/**
 * Builds a ticket code from a key and a random body.
 *
 * `crypto.randomInt` rather than `randomBytes(1) % 27`: 256 does not divide by
 * 27, so the modulo would favour the first thirteen characters of the alphabet.
 * `randomInt` does the rejection sampling that removes that.
 *
 * @param key - The one-character key the code starts with.
 * @returns The key followed by five random characters from the 27-character
 *   alphabet, which has no vowels, `0`, `1`, `3` or `4`.
 */
export const buildTicketCode = (key: string): string => {
  let body = '';

  for (let index = 0; index < TICKET_CODE_BODY_LENGTH; index += 1) {
    // charAt rather than an index: under noUncheckedIndexedAccess the latter
    // is `string | undefined`, and randomInt cannot return an out-of-range one.
    body += TICKET_CODE_ALPHABET.charAt(
      crypto.randomInt(TICKET_CODE_ALPHABET.length),
    );
  }

  return `${key}${body}`;
};
