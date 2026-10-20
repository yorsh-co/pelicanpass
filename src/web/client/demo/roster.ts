/**
 * Fictional ticket codes the demo accepts.
 *
 * Shared by the demo build, which lists them in the banner, and the in-browser
 * mock API, which checks them in. Both are demo-only: nothing under
 * `src/web/client/demo` is an entry point, so the production bundle never
 * includes it.
 *
 * Each is six lowercase alphanumerics, as `isValidTicketCode` requires; the
 * volunteer code carries the volunteer key.
 */
export const DEMO_TICKET_CODES = {
  participant: ['k7m2q9', 'p4x8c3'],
  volunteer: ['v2n5r8'],
} as const;
