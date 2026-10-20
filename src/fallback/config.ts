import {
  readEventClosesAt,
  readEventTimezone,
  readOpensBefore,
} from '../config/event-window.ts';
import { numeric, optional, timestamp } from '../config/read-env.ts';

import type { AttendeeRole } from '../types/attendee.ts';

/**
 * Everything the standalone landing fallback reads from its environment.
 *
 * Deliberately a handful of timing values and nothing else: the fallback
 * exists to stay up while the database, the cache and the production secrets
 * are unavailable, so none of them may be required here. The variable names,
 * formats and defaults are the live app's, read through the same functions, so
 * the lines can be copied from the production `.env` unchanged.
 */
export interface FallbackConfig {
  port: number;
  logLevel: string;
  appTitle: string;

  /** Epoch milliseconds the event starts at, from `EVENT_START_AT`. */
  eventStartAt: number;

  /** How long before `eventStartAt` each audience's window opens. */
  opensBefore: Record<AttendeeRole, number>;

  /** IANA timezone the absolute open time is printed in. */
  timezone: string;

  /**
   * Epoch milliseconds from which the closing page replaces the countdown,
   * from `EVENT_CLOSES_AT`, or `null` to never close.
   */
  closesAt: number | null;
}

/**
 * Reads the fallback's configuration from `process.env`.
 *
 * @throws {Error} If `EVENT_START_AT` is missing or malformed, or any other
 *   value is set but unparseable.
 */
export const readFallbackConfig = (): FallbackConfig => ({
  port: numeric('PORT', 3000),
  logLevel: optional('LOG_LEVEL', 'info'),
  appTitle: optional('APP_TITLE', 'PelicanPass'),
  eventStartAt: timestamp('EVENT_START_AT'),
  opensBefore: readOpensBefore(),
  timezone: readEventTimezone(),
  closesAt: readEventClosesAt(),
});
