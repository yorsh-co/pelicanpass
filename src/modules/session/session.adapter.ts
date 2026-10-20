import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../config/env.ts';
import { sessionService } from './session.service.ts';

import type { Session } from '../../types/session.ts';

/** A session and the ID it is stored under. */
interface SessionRecord<T extends Session> {
  sessionId: string;
  session: T;
}

/**
 * Builds the cookie-aware session helpers a module works with, pairing a
 * cookie name with the factory that seeds that module's session.
 *
 * `type` namespaces this module's sessions in the store. Typing it as
 * `T['type']` makes a namespace that disagrees with its payload a compile
 * error rather than a silent mismatch.
 *
 * @param type - Session type this adapter owns.
 * @param cookieName - Cookie carrying this module's session ID.
 * @param createSessionData - Factory producing a new session for a request.
 */
export const createSessionAdapter = <T extends Session = Session>(
  type: T['type'],
  cookieName: string,
  createSessionData?: (req: Request) => T,
  options: { sameSite?: CookieOptions['sameSite'] } = {},
) => {
  /**
   * Options every session cookie is written with.
   *
   * `path` is Express's default, set explicitly so the scope is stated rather
   * than inherited.
   *
   * **No `maxAge`, deliberately.** `sessionService.save` refreshes the Redis
   * TTL on every write, so sessions expire on a sliding window, while a cookie
   * `maxAge` is absolute. An attendee delayed past the ten-minute check-in TTL
   * would lose the cookie while the session behind it was still alive. A
   * browser-session cookie outliving a dead session is the cheaper failure —
   * the next request resolves nothing and issues a new one.
   *
   * `sameSite` defaults to `'lax'` and is overridable per adapter rather than
   * simply raised for everyone. `'lax'` is load-bearing on the check-in flow,
   * whose entry link arrives from outside the site and 303s to a page that must
   * already see the session the redirect just wrote — `'strict'` would drop the
   * cookie on that navigation. The admin adapter opts into `'strict'` because
   * nothing links into `/admin` from anywhere.
   */
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: options.sameSite ?? 'lax',
    path: '/',
  };

  /**
   * Reads this module's session ID from the request cookies.
   *
   * cookie-parser types `req.cookies` as `any`, so the value is asserted to
   * the only thing a cookie can be.
   */
  const readSessionId = (req: Request): string | undefined =>
    req.cookies[cookieName] as string | undefined;

  /**
   * Sets or unsets this module's session ID in the request cookies, keeping
   * the request's view in step with the cookie written to the response.
   *
   * Asserted like {@link readSessionId}, as `req.cookies` is typed `any`.
   */
  const bindSessionId = (req: Request, sessionId: string | undefined): void => {
    (req.cookies as Record<string, string | undefined>)[cookieName] = sessionId;
  };

  /**
   * Creates a session and sets the session ID cookie on the response.
   *
   * The request is re-bound to the new ID, so later calls on it see the
   * session just created.
   *
   * @param req - Request the session is issued for.
   * @param res - Response the cookie is set on.
   * @param overrides - Fields merged over the factory's output, for state the
   *   factory cannot know — the attendee an attendee session belongs to, say.
   * @throws {Error} If this adapter was built without a session factory.
   */
  const create = async (
    req: Request,
    res: Response,
    overrides: Partial<T> = {},
  ): Promise<SessionRecord<T>> => {
    if (!createSessionData) {
      throw new Error(
        `Cannot create a session for "${cookieName}": no session factory`,
      );
    }

    const data: T = { ...createSessionData(req), ...overrides };

    const { sessionId, session } = await sessionService.create<T>(type, data);

    res.cookie(cookieName, sessionId, cookieOptions);
    bindSessionId(req, sessionId);

    return { sessionId, session };
  };

  /**
   * Reads this module's session from the request.
   *
   * @param req - Request to read the session cookie from.
   * @returns The session, or `null` if there is none for this cookie.
   */
  const get = async (req: Request): Promise<SessionRecord<T> | null> => {
    const sessionId = readSessionId(req);
    if (!sessionId) return null;

    const session = await sessionService.get<T>(type, sessionId, req);
    if (!session) return null;

    return { sessionId, session };
  };

  /**
   * Reads this module's session, creating one if the request carries none.
   *
   * @param req - Request to read the session cookie from.
   * @param res - Response a new session's cookie is set on.
   */
  const ensure = async (
    req: Request,
    res: Response,
  ): Promise<SessionRecord<T>> => {
    const existing = await get(req);

    if (existing) return existing;

    return create(req, res);
  };

  /**
   * Writes the session back to the store.
   *
   * @param sessionId - Session ID to write under.
   * @param session - Session state to store.
   */
  const persist = async (sessionId: string, session: T): Promise<void> => {
    await sessionService.save(type, sessionId, session);
  };

  /**
   * Moves the session to a fresh ID and re-points the cookie at it.
   *
   * The request is re-bound to the new ID, so later calls on it see the
   * rotated session rather than the ID rotation just deleted.
   *
   * @param req - Request the rotated session is re-bound to.
   * @param res - Response the new cookie is set on.
   * @param sessionId - Session ID to rotate away from.
   * @throws {Error} If the session has expired. Callers rotate immediately
   *   after resolving a session, so its absence is an invariant violation
   *   rather than an outcome worth modelling.
   */
  const rotate = async (
    req: Request,
    res: Response,
    sessionId: string,
  ): Promise<SessionRecord<T>> => {
    const rotated = await sessionService.rotate<T>(type, sessionId, req);

    if (!rotated) {
      throw new Error(
        `Cannot rotate "${cookieName}" session: it no longer exists`,
      );
    }

    res.cookie(cookieName, rotated.sessionId, cookieOptions);
    bindSessionId(req, rotated.sessionId);

    return rotated;
  };

  /**
   * Destroys the session named by the request cookie and clears the cookie.
   *
   * The request is unbound from the destroyed ID, so later calls on it find no
   * session rather than looking the dead ID up.
   *
   * @param req - Request to read the session cookie from and unbind.
   * @param res - Response the cookie is cleared on.
   */
  const destroy = async (req: Request, res: Response): Promise<void> => {
    const sessionId = readSessionId(req);

    if (sessionId) {
      await sessionService.destroy(type, sessionId);
    }

    res.clearCookie(cookieName);
    bindSessionId(req, undefined);
  };

  /**
   * Destroys the current session and issues a fresh one.
   *
   * @param req - Request the new session is issued for.
   * @param res - Response the new cookie is set on.
   */
  const reset = async (
    req: Request,
    res: Response,
  ): Promise<SessionRecord<T>> => {
    await destroy(req, res);

    return await ensure(req, res);
  };

  return {
    create,
    ensure,
    get,
    persist,
    rotate,
    destroy,
    reset,
  };
};
