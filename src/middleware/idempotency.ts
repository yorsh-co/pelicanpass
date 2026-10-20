import { ConflictError, ValidationError } from '../shared/errors/app-error.ts';
import { hash } from '../shared/utils/hash.ts';

import type { Request, RequestHandler, Response } from 'express';

/**
 * Lifetime of a claim whose handler has not answered yet.
 *
 * Above the longest handler it guards: an attendee create with the door message
 * ticked waits on the pool, the insert, the door budget transaction and a 10 s
 * Meta send, about 40 s at worst. Short on purpose beyond that, because a claim
 * leaves `pending` only through `res.json`: a process that dies mid-handler
 * leaves it behind, and every re-tap of that action is refused until it lapses.
 */
export const PENDING_TTL_SECONDS = 60;

/**
 * How long a finished action can be replayed.
 *
 * Covers a re-tap after a timeout with room to spare. A client clears its key on
 * any answer, so nothing legitimate replays later than this.
 */
export const DONE_TTL_SECONDS = 600;

/** Any RFC 4122 UUID, as `crypto.randomUUID()` produces. */
const KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The four operations the middleware needs from its store. */
export interface IdempotencyStore {
  /** Sets `key` only if it is absent. Resolves true when this call set it. */
  claim: (key: string, value: string, ttlSeconds: number) => Promise<boolean>;
  get: (key: string) => Promise<string | null>;
  save: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  release: (key: string) => Promise<void>;
}

/** A stored claim: in flight, or finished with the response to replay. */
type IdempotencyRecord =
  | { state: 'pending'; bodyHash: string }
  | { state: 'done'; bodyHash: string; status: number; body: unknown };

/** What {@link createIdempotency} is built from. */
export interface IdempotencyDeps {
  store: IdempotencyStore;

  /** Called when the store fails; the request then runs as if it had no key. */
  warn: (message: string, context: Record<string, unknown>) => void;
}

/**
 * The database ID of whoever the route's session names.
 *
 * Not the session ID, which would put a live credential into the keyspace, and
 * not the session's digest, which a re-login changes, orphaning the key. The
 * ID keeps one actor's responses out of another's reach across both.
 */
const actorIdOf = (req: Request): string | null => {
  const session = req.session;

  if (session?.type === 'admin') return session.adminId;
  if (session?.type === 'attendee') return session.attendeeId;

  return null;
};

/**
 * Parses a stored record.
 *
 * @throws {Error} For anything this module did not write, which the caller
 *   treats as a store failure.
 */
const parseRecord = (raw: string): IdempotencyRecord => {
  const value: unknown = JSON.parse(raw);
  const record = (
    typeof value === 'object' ? value : null
  ) as Partial<IdempotencyRecord> | null;

  if (
    typeof record?.bodyHash === 'string' &&
    (record.state === 'pending' ||
      (record.state === 'done' && typeof record.status === 'number'))
  ) {
    return record as IdempotencyRecord;
  }

  throw new Error('Unrecognised idempotency record');
};

/** What a request with a key turned out to be. */
type Outcome =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'refused'; error: Error }
  | { kind: 'unkeyed' };

/**
 * Stores the handler's answer under the claim before it is sent.
 *
 * Stored first so a re-tap arriving the moment the response leaves finds the
 * result rather than a claim still pending. A `2xx` is kept for replay; any
 * other answer releases the key, so a genuine retry runs the action again.
 */
const settleOnResponse = (
  res: Response,
  claim: { key: string; scope: string; bodyHash: string },
  { store, warn }: IdempotencyDeps,
): void => {
  const { key, scope, bodyHash } = claim;
  const send = res.json.bind(res);

  res.json = (body: unknown) => {
    const status = res.statusCode;

    const settled =
      status >= 200 && status < 300
        ? store.save(
            key,
            JSON.stringify({ state: 'done', bodyHash, status, body }),
            DONE_TTL_SECONDS,
          )
        : store.release(key);

    // Sent whether or not the record landed: the action already ran, and the
    // answer is the client's either way. Sending now happens after an await,
    // so a throw from it is caught here rather than left unhandled.
    void settled
      .catch((err: unknown) => {
        warn('idempotency record not settled', { scope, err });
      })
      .then(() => send(body))
      .catch((err: unknown) => {
        warn('response failed after settling its idempotency record', {
          scope,
          err,
        });
      });

    return res;
  };
};

/**
 * Builds the `idempotent` middleware over a store.
 *
 * Kept apart from its Redis wiring so the behaviour can be tested without a
 * server: see `idempotency.middleware.ts` for the instance routes mount.
 *
 * @param deps - The store and a warning sink.
 * @returns The middleware factory.
 */
export const createIdempotency = (deps: IdempotencyDeps) => {
  const { store, warn } = deps;

  /** Claims `key`, or reports what an earlier claim on it means for this one. */
  const resolve = async (key: string, bodyHash: string): Promise<Outcome> => {
    const claimed = await store.claim(
      key,
      JSON.stringify({ state: 'pending', bodyHash }),
      PENDING_TTL_SECONDS,
    );

    if (claimed) return { kind: 'claimed' };

    const raw = await store.get(key);

    // Lapsed between the claim and the read: the first attempt may still be
    // running, so it is treated as pending.
    const record = raw === null ? null : parseRecord(raw);

    if (record && record.bodyHash !== bodyHash) {
      return {
        kind: 'refused',
        error: new ValidationError(
          'Idempotency-Key reused with a different body',
        ),
      };
    }

    if (record?.state === 'done') {
      return { kind: 'replay', status: record.status, body: record.body };
    }

    return {
      kind: 'refused',
      error: new ConflictError('Request in progress', {
        reason: 'requestInProgress',
      }),
    };
  };

  /**
   * Makes one route safe to repeat with an `Idempotency-Key`.
   *
   * The client sends the same key for every tap of one logical action. The
   * first request claims it and runs; a repeat while it runs is refused with
   * `requestInProgress`; a repeat after it succeeded gets the stored response
   * with `Idempotent-Replay: true`, and the action does not run again.
   *
   * A request without the header runs as before, so a page loaded before the
   * release keeps working. A store failure fails open for the same reason:
   * without Redis there are no sessions, so refusing would protect nothing.
   *
   * Mount after the route's session and permission checks: the key is scoped
   * to the session's actor.
   *
   * @param scope - Names the action in the key, so one key cannot cross routes.
   * @returns The middleware.
   */
  return (scope: string): RequestHandler =>
    async (req, res, next) => {
      const header = req.get('Idempotency-Key');
      const actorId = actorIdOf(req);

      if (header === undefined || !actorId) {
        next();

        return;
      }

      if (!KEY_PATTERN.test(header)) {
        next(new ValidationError('Invalid Idempotency-Key'));

        return;
      }

      const key = `idem:${scope}:${actorId}:${header.toLowerCase()}`;
      const bodyHash = hash(JSON.stringify(req.body ?? null));

      // Decided inside the try, acted on outside it, so an error thrown further
      // down the chain can never be mistaken for a store failure.
      let outcome: Outcome;

      try {
        outcome = await resolve(key, bodyHash);
      } catch (err) {
        // The key embeds the actor's ID, so only the scope is logged.
        warn('idempotency store failed; running without a key', { scope, err });
        outcome = { kind: 'unkeyed' };
      }

      switch (outcome.kind) {
        case 'claimed':
          settleOnResponse(res, { key, scope, bodyHash }, deps);
          next();
          break;
        case 'replay':
          res.set('Idempotent-Replay', 'true');
          res.status(outcome.status).json(outcome.body);
          break;
        case 'refused':
          next(outcome.error);
          break;
        case 'unkeyed':
          next();
          break;
      }
    };
};
