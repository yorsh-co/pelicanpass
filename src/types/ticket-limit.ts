/**
 * The ticket limit: a cap on how many participant tickets the attendees editor
 * can issue.
 *
 * Shared with the admin client, which renders the roster's panel and the form's
 * banner from {@link TicketLimitOverview}. Travels over the API as codes and
 * numbers, never prose.
 *
 * This module is imported by browser code, so it must stay free of Node
 * built-ins.
 */

/**
 * What counts towards the cap.
 *
 * - `off`: nothing; there is no limit.
 * - `total`: every participant ticket, however it was issued.
 * - `door`: only the codes the editor generated (`d*`). A code typed by hand is
 *   not counted.
 */
export type TicketLimitScope = 'off' | 'total' | 'door';

/**
 * What reaching the cap does.
 *
 * - `hard`: creating or restoring a counted attendee is refused.
 * - `warn`: nothing is refused; the response says the cap is reached.
 */
export type TicketLimitMode = 'hard' | 'warn';

/**
 * How close usage is to the cap.
 *
 * `ok` is below 90% of the cap, `near` from 90%, `reached` exactly at the cap,
 * `over` above it, and `off` when there is no limit.
 */
export type TicketLimitStatus = 'off' | 'ok' | 'near' | 'reached' | 'over';

/** The limit as an administrator sets it, and as it is stored. */
export interface TicketLimitSetting {
  scope: TicketLimitScope;

  /** Null only for an `off` limit that has never held a cap. */
  cap: number | null;

  mode: TicketLimitMode;
}

/** What the roster's panel and the form's banner show. */
export interface TicketLimitOverview extends TicketLimitSetting {
  /** Tickets counted towards the cap under the current scope. */
  used: number;

  /** Cap minus used: null when off, negative when over. */
  remaining: number | null;

  status: TicketLimitStatus;
}
