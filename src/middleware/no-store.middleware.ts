import type { RequestHandler } from 'express';

/**
 * Keeps a rendered page out of the browser's own stores.
 *
 * Without a directive Express sends an `ETag` and no freshness information at
 * all, which leaves the response body in the browser's disk cache — a store that
 * outlives the session, the tailnet grant and teardown, exactly like the history
 * entry `docs/security/data-retention.md` was written to close.
 *
 * That document already covers the URL and the page title. This is the third
 * part of the same rule and covers the response body, so no surface writes
 * anything about an attendee to a device it does not own.
 *
 * Both surfaces need it, for reasons that are not the same one twice:
 *
 * - **The administrator pages** are the only ones that render a full name, a
 *   full phone number or a verification code, and they are read on the
 *   operators' personal phones.
 * - **The attendee pages** are on a personal device by definition. `/checkin`
 *   carries the masked name and `phoneStart` preview, and the pass is the one
 *   body in this application that carries a live bearer credential — plus the
 *   ticket code, which `git show d0aa585:docs/anti-fraud-pass-plan.md` (in
 *   the private archive repository) records as half of the check-in
 *   credential.
 *
 * The API router mounts it first as well, so every JSON response carries it,
 * refusals included. Six controllers still set it by hand from before that;
 * the router-level mount is what holds the invariant.
 *
 * `no-store` alone, matching those controllers. The longer incantations add
 * nothing that `no-store` does not already say.
 *
 * A side effect worth knowing rather than relying on: Chrome and Firefox both
 * decline to put a `no-store` response in the back/forward cache, which narrows
 * the gap `docs/security/data-retention.md` records as a thing it does not claim.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
