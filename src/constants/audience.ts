import type { AttendeeRole } from '../types/attendee.ts';

/**
 * Single source of truth for which audiences this app renders copy for.
 *
 * `?audience=` reaches the DOM by two independent routes — the server writes
 * `data-audience` on the layout body, the browser writes it again from
 * `ensureAudience` — so both import this rather than validating separately.
 *
 * Values match `AttendeeRole` because the audience *is* the attendee's role;
 * the parameter exists only so the page can pick copy before a session has
 * resolved one.
 *
 * Imported by browser code, so it must stay free of Node built-ins.
 *
 * @param value - Candidate audience, typically straight off the query string.
 * @returns Whether the value names an audience with copy.
 */
export const isAudienceRole = (value: unknown): value is AttendeeRole =>
  value === 'participant' || value === 'volunteer';

/**
 * Narrows an unvalidated query value to a known audience.
 *
 * Returns `undefined` rather than a default so an unrecognised value renders
 * exactly as a missing one does — the templates already treat absence as "no
 * audience yet" and the browser resolves it from the session.
 *
 * @param value - Raw query value, which Express types as possibly repeated or
 *   nested and therefore possibly not a string at all.
 */
export const toAudienceRole = (value: unknown): AttendeeRole | undefined =>
  isAudienceRole(value) ? value : undefined;
