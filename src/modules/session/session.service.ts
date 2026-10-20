import { randomUUID } from 'crypto';
import type { Request } from 'express';

import { env } from '../../config/env.ts';
import redis from '../../shared/db/redis.ts';
import { logger } from '../../shared/logger/logger.ts';
import { hash, hashUA } from '../../shared/utils/hash.ts';

import type { Session, SessionType } from '../../types/session.ts';

/** Result of creating or rotating a session. */
interface SessionRecord<T extends Session> {
  sessionId: string;
  session: T;
}

const isProduction = env.nodeEnv === 'production';

/**
 * Builds the Redis key a session is stored under from an already-hashed ID.
 *
 * Split out from {@link getKey} for the one caller that holds a digest rather
 * than the ID behind it — `displacePriorSession`, which is handed the digest of
 * the session it displaced and never learns that session's ID.
 *
 * @param type - Session type owning the key.
 * @param digest - Hashed session ID.
 * @returns The namespaced Redis key.
 */
const getKeyByDigest = (type: SessionType, digest: string): string =>
  `session:${type}:${digest}`;

/**
 * Builds the Redis key a session is stored under.
 *
 * The ID is hashed so a dump, backup or `SCAN` yields digests rather than live
 * session IDs. A bare SHA-256 suffices — the ID is 122 bits from a CSPRNG, so
 * there is nothing to brute-force and no salt or KDF to manage.
 *
 * @param type - Session type owning the key.
 * @param id - Session ID carried by the cookie.
 * @returns The namespaced Redis key.
 */
const getKey = (type: SessionType, id: string): string =>
  getKeyByDigest(type, hash(id));

/**
 * Builds the key pointing at the newest session an attendee holds.
 *
 * The attendee ID is hashed for the same reason session IDs are — a keyspace
 * dump should yield digests, not a roster of who is currently checked in. A
 * bare SHA-256 is enough because the ID is a v4 UUID, the same shape of value
 * `getKey` already relies on it for.
 *
 * @param attendeeId - Attendee whose newest session is being pointed at.
 * @returns The namespaced Redis key.
 */
const getCurrentKey = (attendeeId: string): string =>
  `session:attendee:current:${hash(attendeeId)}`;

/**
 * Resolves the Redis TTL for a session type.
 *
 * The range check stays even though `env.sessionTtl` is typed as numbers:
 * these values come from the environment via `Number()`, so a malformed one
 * arrives as `NaN` rather than failing to parse.
 *
 * @param type - Session type to look up.
 * @throws {Error} If the configured TTL is not a positive integer.
 */
const getTtlByType = (type: SessionType): number => {
  const ttl = env.sessionTtl[type];

  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`Invalid TTL for ${type}: ${String(ttl)}`);
  }

  return ttl;
};

/**
 * Revokes whatever session an attendee was already holding.
 *
 * An attendee who has checked in can run the flow again — `applyStep` skips the
 * QR step once `checkinComplete` is set and `completeCheckin` is idempotent —
 * and each pass issues a fresh session. Without this, those pile up: one ticket
 * code, many live sessions, each good for a full TTL, and each one a credential
 * for the volunteer surfaces as well as the pass.
 *
 * Sessions are keyed by a digest of their own ID, so the store cannot be asked
 * which sessions belong to an attendee. This pointer carries that link instead.
 * Swapping it with `SET … GET` is one atomic command, so two check-ins racing
 * for the same attendee cannot both believe they won — the loser's digest comes
 * back to the winner and is deleted. Contrast `rotateSession` below, whose
 * three round trips have a gap between them.
 *
 * `SET … GET` requires **Redis 6.2 or newer**, which is why the `cache` image
 * is pinned in both compose files rather than floating on `latest`.
 *
 * The pointer takes the session TTL rather than one of its own. Attendee
 * sessions are written once and never saved again, so their TTL is absolute
 * from creation and the two expire in lockstep.
 *
 * **Best-effort.** The caller has already committed the arrival number to
 * Postgres and has yet to set the session cookie, so a Redis failure here must
 * not become the attendee's response. Neither failure is silent-and-permanent:
 *
 * - The `SET` fails — the pointer still names the previous session, and the new
 *   one is live but untracked. The next check-in displaces the *previous*
 *   session and leaves this one to run out its TTL.
 * - The `DEL` fails — the pointer is correct, and the displaced session runs
 *   out its TTL instead of ending now.
 *
 * @param attendeeId - Attendee the new session belongs to.
 * @param sessionId - Session ID that now represents the attendee.
 */
const displacePriorSession = async (
  attendeeId: string,
  sessionId: string,
): Promise<void> => {
  try {
    const previousDigest = await redis.set(
      getCurrentKey(attendeeId),
      hash(sessionId),
      'EX',
      getTtlByType('attendee'),
      'GET',
    );

    if (!previousDigest) return;

    await redis.del(getKeyByDigest('attendee', previousDigest));
  } catch (err) {
    logger.warn({ err }, 'Could not displace the prior attendee session');
  }
};

/**
 * Deletes a key only if it still holds the value the caller expects.
 *
 * A plain `DEL` of the pointer would open the hole the pointer exists to close:
 * a check-in on another device can overwrite it between the read and the
 * delete, and removing *that* value leaves the newer session live with nothing
 * naming it, so no later check-in can displace it. `EVAL` closes the gap the
 * way a lock release does.
 */
const DELETE_IF_EQUALS = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Drops the pointer naming an attendee's session, if it still names this one.
 *
 * Best-effort for the same reason as {@link displacePriorSession}: a stale
 * pointer costs nothing — it names a digest that is already gone, and the next
 * check-in overwrites it — so a failure here is not worth failing a sign-out
 * over.
 *
 * @param attendeeId - Attendee the pointer belongs to.
 * @param sessionId - Session ID the pointer must name for it to be dropped.
 */
const clearCurrentPointer = async (
  attendeeId: string,
  sessionId: string,
): Promise<void> => {
  try {
    await redis.eval(
      DELETE_IF_EQUALS,
      1,
      getCurrentKey(attendeeId),
      hash(sessionId),
    );
  } catch (err) {
    logger.warn({ err }, 'Could not clear the attendee session pointer');
  }
};

/**
 * Persists a new session under a fresh ID.
 *
 * @param type - Session type, bound by the calling adapter.
 * @param data - Fully-formed session state from a module's session model.
 * @returns The new session ID and the stored session.
 */
const createSession = async <T extends Session>(
  type: SessionType,
  data: T,
): Promise<SessionRecord<T>> => {
  const sessionId = randomUUID();

  const session = {
    ...data,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const ttl = getTtlByType(type);

  await redis.set(getKey(type, sessionId), JSON.stringify(session), 'EX', ttl);

  // Narrowed through a Session-typed local because TypeScript will not narrow a
  // generic on its discriminant.
  const stored: Session = session;

  if (stored.type === 'attendee') {
    if (!stored.attendeeId) {
      // Warned in every environment, unlike the displacement below: the only
      // caller seeds `attendeeId` through the adapter's overrides, so reaching
      // this is a wiring mistake, and its cost is an attendee session that no
      // later check-in can displace.
      logger.warn(
        'Attendee session created without an attendee; prior sessions not displaced',
      );
    } else if (isProduction) {
      // Only in production: issuing a second session is how both surfaces get
      // exercised side by side in development.
      //
      // After the new session is written, never before — displacing first
      // revokes the session the attendee holds before its replacement exists.
      await displacePriorSession(stored.attendeeId, sessionId);
    }
  }

  return { sessionId, session };
};

/**
 * Loads a session, rejecting it if it is not of the expected type or if the
 * User-Agent no longer matches the one it was issued to.
 *
 * The discriminator check is defence in depth rather than the primary control:
 * keys are namespaced by type, so a session of another type is not reachable
 * through this path at all. Reaching one means the stored payload disagrees
 * with the key it lives under, which nothing in this application can produce —
 * hence the warning rather than a silent miss.
 *
 * @param type - Session type, bound by the calling adapter.
 * @param sessionId - Session ID from the request cookie, if present.
 * @param req - Request whose User-Agent is checked against the session.
 * @returns The session, or `null` if it is missing, of another type, or bound
 *   to another agent.
 */
const getSession = async <T extends Session>(
  type: SessionType,
  sessionId: string | undefined,
  req: Request,
): Promise<T | null> => {
  if (!sessionId) return null;

  const raw = await redis.get(getKey(type, sessionId));
  if (!raw) return null;

  const session = JSON.parse(raw) as Session;

  if (session.type !== type) {
    req.log.warn(
      { expected: type, stored: session.type },
      'Session type does not match its key namespace',
    );

    return null;
  }

  if (session.ua !== hashUA(req.headers['user-agent'])) {
    return null;
  }

  return session as T;
};

/**
 * Writes a session back, refreshing its TTL and `updatedAt`.
 *
 * @param type - Session type, bound by the calling adapter.
 * @param sessionId - Session ID to write under.
 * @param session - Session state to store.
 * @returns The stored session, including the new `updatedAt`.
 */
const saveSession = async <T extends Session>(
  type: SessionType,
  sessionId: string,
  session: T,
): Promise<T> => {
  const updatedSession = {
    ...session,
    updatedAt: Date.now(),
  };

  const ttl = getTtlByType(type);

  await redis.set(
    getKey(type, sessionId),
    JSON.stringify(updatedSession),
    'EX',
    ttl,
  );

  return updatedSession;
};

/**
 * Deletes a session, and for an attendee the pointer naming it.
 *
 * The pointer key is derived from the attendee ID, which only the stored
 * session carries, so it has to be read before the session goes. That read is
 * confined to attendee sessions, and sign-out is the only path that reaches it.
 *
 * The session is deleted first: a pointer left behind names a digest that no
 * longer resolves, which the next check-in overwrites anyway, whereas clearing
 * the pointer first and then failing to delete would leave a live session with
 * nothing naming it. Ungated by environment — the pointer has to be cleaned up
 * whatever mode wrote it.
 *
 * @param type - Session type, bound by the calling adapter.
 * @param sessionId - Session ID to delete.
 */
const destroySession = async (
  type: SessionType,
  sessionId: string,
): Promise<void> => {
  const raw =
    type === 'attendee' ? await redis.get(getKey(type, sessionId)) : null;

  await redis.del(getKey(type, sessionId));

  if (!raw) return;

  const session = JSON.parse(raw) as Session;

  if (session.type !== 'attendee' || !session.attendeeId) return;

  await clearCurrentPointer(session.attendeeId, sessionId);
};

/**
 * Moves a session to a fresh ID, re-binding it to the current User-Agent.
 *
 * Used after a privilege change so a session ID captured earlier in the flow
 * is no longer valid.
 *
 * **Check-in sessions only, and not by accident.** An attendee session is named
 * by a pointer holding the digest of the ID it was created under, and nothing
 * here updates that pointer: rotating one would strand it on a dead digest and
 * put the rotated session beyond the reach of the next check-in's displacement
 * — one attendee holding two live sessions, which is what the pointer exists to
 * prevent. The check-in session has no pointer, and is the only caller today.
 *
 * The old key's `DEL` and the new key's `SET` run in one `MULTI`, so a failure
 * leaves the old session intact rather than the attendee with none. That is
 * also why this uses a bare `DEL` instead of {@link destroySession}, whose
 * pointer cleanup is attendee-only.
 *
 * @param type - Session type, bound by the calling adapter.
 * @param oldSessionId - Session ID to rotate away from.
 * @param req - Request the rotated session is re-bound to.
 * @returns The new ID and session, or `null` if the old session had expired.
 */
const rotateSession = async <T extends Session>(
  type: SessionType,
  oldSessionId: string,
  req: Request,
): Promise<SessionRecord<T> | null> => {
  const oldSessionRaw = await redis.get(getKey(type, oldSessionId));
  if (!oldSessionRaw) return null;

  const oldSession = JSON.parse(oldSessionRaw) as T;

  const newSessionId = randomUUID();

  const newSession = {
    ...oldSession,
    ua: hashUA(req.headers['user-agent']),
    updatedAt: Date.now(),
  };

  const ttl = getTtlByType(type);

  const results = await redis
    .multi()
    .del(getKey(type, oldSessionId))
    .set(getKey(type, newSessionId), JSON.stringify(newSession), 'EX', ttl)
    .exec();

  // ioredis reports a failed command in its tuple rather than rejecting, and
  // resolves `null` if the transaction was aborted.
  const failure = results?.find(([err]) => err)?.[0];

  if (!results || failure) {
    throw failure ?? new Error('Session rotation transaction was aborted');
  }

  return { sessionId: newSessionId, session: newSession };
};

export {
  createSession,
  getSession,
  saveSession,
  destroySession,
  rotateSession,
};

export const sessionService = {
  create: createSession,
  get: getSession,
  save: saveSession,
  destroy: destroySession,
  rotate: rotateSession,
};
