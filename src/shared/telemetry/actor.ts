import type { Request } from 'express';

import { hash } from '../utils/hash.ts';

/**
 * Turns a session ID into the handle `app_events` stores for it.
 *
 * The session ID is a bearer credential, so it must not sit at rest where the
 * readonly role and `psql` can read it. A digest prefix still ties one
 * session's rows together, and cannot be replayed or reversed. Migration
 * `025_app-events-actor-digest.ts` derives the same value in SQL for rows written
 * before this, so old and new rows correlate.
 *
 * @param id - The session ID, if there was one.
 * @returns 16 hex characters, or undefined without an ID.
 */
const actorHandle = (id: string | undefined): string | undefined =>
  id ? hash(id).slice(0, 16) : undefined;

/** Who a request was acting as, and from where. */
export interface RequestActor {
  readonly actorType: string;
  readonly actorId: string | undefined;
  readonly ip: string | undefined;
}

/**
 * Reads the actor and address off a request, for the `app_events` columns.
 *
 * Lives here rather than in `record.ts` so that module stays free of Express:
 * `server.ts`'s fatal handler records with no request at all, and a recorder
 * that needed one could not.
 *
 * `session` is the one the current route required; `sessions` is everything
 * resolved from the cookies. Preferring the former means a request that went
 * through `requireSessionType` is attributed to the session it was actually
 * authorised against rather than to whichever cookie sorted first.
 *
 * Returns a **pseudonymous handle**, never the session ID or a name: a digest
 * that correlates one session's rows and points at nothing on its own, which
 * is what makes it safe to keep beside an IP. See {@link actorHandle}.
 *
 * @param req - The request being recorded.
 * @returns Actor type, actor handle and address.
 */
export const actorOf = (req: Request): RequestActor => {
  const type = req.session?.type;

  if (type) {
    return {
      actorType: type,
      actorId: actorHandle(req.sessionId ?? req.sessionIds?.[type]),
      ip: req.ip,
    };
  }

  // Nothing the route required, so fall back to whatever was resolved. Order is
  // most-privileged first: an administrator holding an attendee cookie as well
  // is more usefully recorded as the administrator.
  for (const candidate of ['admin', 'attendee', 'checkin'] as const) {
    const id = req.sessionIds?.[candidate];

    if (id) {
      return { actorType: candidate, actorId: actorHandle(id), ip: req.ip };
    }
  }

  return { actorType: 'anon', actorId: undefined, ip: req.ip };
};
