/**
 * Single source of truth for the display name an attendee may choose.
 *
 * The same rules are enforced in three places — the server, which is the only
 * boundary that counts; the browser, for immediate feedback; and the `pattern`
 * attribute on the input. Same reasoning as `constants/ticket.ts`, and the
 * pattern is exported unanchored as a string for the same reason: an HTML
 * `pattern` takes a source string and is implicitly anchored by the browser.
 *
 * This module is imported by browser code, so it must stay free of Node
 * built-ins and of anything the client tsconfig excludes.
 */

/**
 * Shortest storable value. A shorter one is not rejected — it is normalised to
 * empty and clears the nickname, which is how an attendee opts back out.
 */
export const NICKNAME_MIN_LENGTH = 2;

/**
 * Longest storable value, in code points.
 *
 * Set by the pass rather than by the column: `.pass-greeting` renders at
 * `--text-xl` and wraps the name into a sentence, and much past this the
 * check-in number — the point of the screen — is pushed off a small viewport.
 */
export const NICKNAME_MAX_LENGTH = 24;

/**
 * Characters a nickname may contain: letters, combining marks, digits, space,
 * apostrophe and hyphen.
 *
 * Admits `João`, `Zé`, `D'Angelo` and `Ana-Clara`. Excludes emoji, punctuation
 * and every character that could be read as markup — a whitelist rather than a
 * denylist, because this is the first attendee-controlled string the
 * application stores and re-renders.
 */
export const NICKNAME_INPUT_PATTERN = `[\\p{L}\\p{M}\\p{N} '\\-]{${String(NICKNAME_MIN_LENGTH)},${String(NICKNAME_MAX_LENGTH)}}`;

const NICKNAME_RE = new RegExp(`^${NICKNAME_INPUT_PATTERN}$`, 'u');

/** At least one letter, so `--` and `1234` do not pass as names. */
const HAS_LETTER_RE = /\p{L}/u;

/**
 * Three or more combining marks in a row.
 *
 * The whitelist admits `\p{M}`, and the length limit alone would allow a base
 * character to carry twenty of them — which renders as a vertical tower that
 * escapes its own box and overlays the rest of the pass. After NFC every accent
 * Portuguese needs is precomposed, so two in a row is already generous.
 */
const MARK_RUN_RE = /\p{M}{3,}/u;

/**
 * Control, format and unassigned code points.
 *
 * Stripping these is the security-relevant step, not a tidying one. It removes
 * zero-width spaces and joiners, which are invisible padding that defeats a
 * length limit and makes two different values render identically, and the
 * bidirectional overrides (`U+202E` and friends), which reverse the rendering
 * of everything after them so a stored string can display as something other
 * than what it is.
 */
const CONTROL_AND_FORMAT_RE = /\p{C}/gu;

/** Any run of whitespace, including the non-breaking and ideographic kinds. */
const WHITESPACE_RUN_RE = /\s+/gu;

/**
 * Reduces a typed value to the exact string that would be stored.
 *
 * Order matters. NFC first, so a name typed with combining accents is one
 * canonical string and the length limit means the same thing for everyone.
 * Whitespace is collapsed before the control strip so that a tab or a newline
 * becomes a word gap rather than vanishing and joining two words together.
 *
 * Normalising rather than rejecting is deliberate for the invisible characters:
 * they cannot be seen, so an error message about them cannot be acted on, and
 * the stripped result is exactly what the attendee believed they typed.
 *
 * @param raw - Value as received, from a request body or an input element.
 * @returns The canonical form, which may be empty.
 */
export const normaliseNickname = (raw: string): string =>
  raw
    .normalize('NFC')
    .replace(WHITESPACE_RUN_RE, ' ')
    .replace(CONTROL_AND_FORMAT_RE, '')
    .trim();

/**
 * Reports whether a normalised value may be stored.
 *
 * Says nothing about the empty string, which is not invalid: it is the
 * instruction to clear the nickname, and callers test for it separately.
 *
 * @param value - Value already through {@link normaliseNickname}.
 */
export const isValidNickname = (value: string): boolean =>
  NICKNAME_RE.test(value) &&
  HAS_LETTER_RE.test(value) &&
  !MARK_RUN_RE.test(value);
