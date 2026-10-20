/**
 * Bounds of the ticket limit's cap.
 *
 * Read by the rules that validate the panel's input, by migration `036`'s
 * `CHECK` (which repeats them as literals, being a snapshot), and by the admin
 * client, which names them in the refusal shown when a cap is out of range.
 *
 * This module is imported by browser code, so it must stay free of Node
 * built-ins.
 */

/** Smallest cap that can be set: a limit of zero is `off`, not a cap. */
export const TICKET_LIMIT_CAP_MIN = 1;

/** Largest cap that can be set. Far above any roster; it only stops typos. */
export const TICKET_LIMIT_CAP_MAX = 100_000;
