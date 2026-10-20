/**
 * Single source of truth for ticket code shape.
 *
 * The same rules are enforced in three places — the server validator, the
 * browser input that decides when a typed value is worth submitting, and the
 * `pattern` attribute on the input element. They were three separate literals
 * and had to be edited in lockstep; drift meant the client rejecting codes the
 * server accepts, or the reverse.
 *
 * A code is exactly six lowercase alphanumerics with no hyphen or symbol. Its
 * first character is a key saying where the code came from; the other five are
 * the body.
 *
 * The pattern is exported unanchored as a string because an HTML `pattern`
 * attribute takes a source string, not a `RegExp`, and is implicitly anchored
 * by the browser. The anchored `RegExp` below is built from that same string so
 * the two cannot diverge.
 *
 * This module is imported by browser code, so it must stay free of Node
 * built-ins and of anything the client tsconfig excludes.
 */

/** Key marking a volunteer code. */
export const VOLUNTEER_TICKET_PREFIX = 'v';

/**
 * Reserved key marking an attendee the editor created at the door (a walk-in).
 *
 * **A reserved key, not a participant key**, and the difference is the reason
 * it exists. Participants carry a code the external sign-up system issued, with
 * a key in front. Generating a code under one of those keys here could collide
 * with a code the roster has not issued yet. `UNIQUE` cannot catch that: the
 * other row does not exist at the moment of generation.
 *
 * So the editor generates walk-in codes under this key alone, and the roster
 * importer rejects any code that starts with it. The two namespaces cannot
 * overlap: no roster code carries this key, and no other key is ever generated.
 * Any other key says nothing about who the participant is.
 */
export const WALK_IN_TICKET_PREFIX = 'd';

/**
 * Ticket codes: six lowercase alphanumerics, a one-character key followed by
 * five. Any key other than {@link VOLUNTEER_TICKET_PREFIX} and
 * {@link WALK_IN_TICKET_PREFIX} names an external ticket source, and its five
 * characters are the ones that source's sign-up system issues. The shape is
 * deliberately generic so a new source needs no code change here, only a roster
 * that uses it.
 */
export const TICKET_CODE_PATTERN = '[a-z0-9]{6}';

/**
 * Value for the ticket input's `pattern` attribute.
 *
 * The same string the anchored validator below is built from, so the attribute
 * and the validator cannot disagree.
 */
export const TICKET_INPUT_PATTERN = TICKET_CODE_PATTERN;

/** Total length of every ticket code. */
export const TICKET_CODE_LENGTH = 6;

const TICKET_CODE_RE = new RegExp(`^${TICKET_CODE_PATTERN}$`);

/** Where a participant's ticket came from, judged by its prefix. */
export type TicketPrefixKind = 'generated' | 'external';

/**
 * Classifies a ticket prefix by who issued the code.
 *
 * `generated` is the attendees editor ({@link WALK_IN_TICKET_PREFIX}) and
 * `external` is any other key. Volunteer codes are not special-cased: they never
 * belong to a participant, so callers grouping participants do not meet them.
 *
 * @param prefix - A ticket's one-character key, such as `x`, `7` or `d`.
 */
export const ticketPrefixKind = (prefix: string): TicketPrefixKind =>
  prefix === WALK_IN_TICKET_PREFIX ? 'generated' : 'external';

/**
 * Reports whether a value is a well-formed ticket code: exactly six lowercase
 * alphanumerics.
 *
 * Format only — it says nothing about whether the code was issued, nor what the
 * key character means.
 *
 * @param value - Normalised (lowercased, trimmed) candidate code.
 */
export const isValidTicketCode = (value: string): boolean =>
  TICKET_CODE_RE.test(value);

/**
 * Normalises typed input towards a ticket code, one keystroke at a time.
 *
 * Lowercases, drops characters a code cannot hold (hyphens included) and caps
 * the result at {@link TICKET_CODE_LENGTH}.
 *
 * @param value - Value typed or pasted so far.
 */
export const formatTicket = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, TICKET_CODE_LENGTH);

/**
 * Renders a stored ticket code for people to read.
 *
 * Display only. Codes are stored, validated and matched lowercase, and
 * {@link formatTicket} lowercases typed input, so an uppercased copy read off
 * a pass or a message still checks in.
 *
 * @param code - Ticket code as stored.
 */
export const displayTicketCode = (code: string): string => code.toUpperCase();
