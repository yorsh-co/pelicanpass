import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AppError } from '../shared/errors/app-error.ts';
import { hash } from '../shared/utils/hash.ts';

import {
  createIdempotency,
  DONE_TTL_SECONDS,
  PENDING_TTL_SECONDS,
} from './idempotency.ts';

import type { IdempotencyStore } from './idempotency.ts';
import type { NextFunction, Request, Response } from 'express';

const KEY = '0b6f3c3e-7d0a-4f43-9d55-5f1c2f8f6a01';
const ADMIN_ID = '557b4826-dd30-4f2e-b90a-caa21eff7b35';
const OTHER_ADMIN_ID = '964ab636-9c7c-47c2-a5c7-71f217fba0b4';

/** A store over a `Map`, recording each write's TTL. */
const memoryStore = () => {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();

  const store: IdempotencyStore = {
    claim: (key, value, ttlSeconds) => {
      if (data.has(key)) return Promise.resolve(false);

      data.set(key, value);
      ttls.set(key, ttlSeconds);

      return Promise.resolve(true);
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    save: (key, value, ttlSeconds) => {
      data.set(key, value);
      ttls.set(key, ttlSeconds);

      return Promise.resolve();
    },
    release: (key) => {
      data.delete(key);

      return Promise.resolve();
    },
  };

  return { store, data, ttls };
};

/** What a test varies about a request; `key: null` sends no header. */
interface RequestFields {
  key?: string | null;
  adminId?: string;
  body?: unknown;
}

/** Only what the middleware reads off a request. */
const request = ({
  key = KEY,
  adminId = ADMIN_ID,
  body = { name: 'Ana' },
}: RequestFields = {}): Request =>
  ({
    get: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? (key ?? undefined) : undefined,
    session: { type: 'admin', adminId },
    body,
  }) as unknown as Request;

/** What one pass through the middleware and handler produced. */
interface Result {
  error?: unknown;
  handled: boolean;
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

/**
 * Runs the middleware for one request, then a handler answering
 * `handlerStatus` when the middleware lets it through.
 *
 * Settles once the response is sent or `next` is called with an error, as the
 * middleware sends asynchronously after settling its record.
 */
const run = (
  middleware: ReturnType<ReturnType<typeof createIdempotency>>,
  req: Request,
  handlerStatus = 200,
): Promise<Result> =>
  new Promise((resolve) => {
    const result: Result = { handled: false, headers: {} };

    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;

        return this;
      },
      set(name: string, value: string) {
        result.headers[name] = value;

        return this;
      },
      json(body: unknown) {
        result.status = this.statusCode;
        result.body = body;
        resolve(result);

        return this;
      },
    };

    const next: NextFunction = (err?: unknown) => {
      if (err) {
        result.error = err;
        resolve(result);

        return;
      }

      // The route's handler.
      result.handled = true;
      res.status(handlerStatus).json({ success: handlerStatus < 300 });
    };

    void middleware(req, res as unknown as Response, next);
  });

/** The `AppError` a refused request was passed to `next` with. */
const appError = (result: Result): AppError => {
  assert.ok(result.error instanceof AppError, 'expected an AppError');

  return result.error;
};

describe('idempotent', () => {
  let memory: ReturnType<typeof memoryStore>;
  let warnings: string[];
  let idempotent: ReturnType<typeof createIdempotency>;

  beforeEach(() => {
    memory = memoryStore();
    warnings = [];
    idempotent = createIdempotency({
      store: memory.store,
      warn: (message) => {
        warnings.push(message);
      },
    });
  });

  it('runs the first request and keeps its success for replay', async () => {
    const result = await run(idempotent('create'), request(), 201);

    assert.equal(result.handled, true);
    assert.equal(result.status, 201);

    const key = `idem:create:${ADMIN_ID}:${KEY}`;
    const stored = JSON.parse(memory.data.get(key) ?? '{}') as {
      state: string;
      status: number;
    };

    assert.equal(stored.state, 'done');
    assert.equal(stored.status, 201);
    assert.equal(memory.ttls.get(key), DONE_TTL_SECONDS);
  });

  it('replays a finished request without running it again', async () => {
    await run(idempotent('create'), request(), 201);

    const replay = await run(idempotent('create'), request(), 201);

    assert.equal(replay.handled, false);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, { success: true });
    assert.equal(replay.headers['Idempotent-Replay'], 'true');
  });

  it('claims with the short pending lifetime', async () => {
    const { store, ttls } = memory;
    const claims: number[] = [];

    idempotent = createIdempotency({
      store: {
        ...store,
        claim: (key, value, ttlSeconds) => {
          claims.push(ttlSeconds);

          return store.claim(key, value, ttlSeconds);
        },
      },
      warn: () => undefined,
    });

    await run(idempotent('create'), request());

    assert.deepEqual(claims, [PENDING_TTL_SECONDS]);
    assert.equal(ttls.size, 1);
  });

  it('refuses a repeat while the first is still running', async () => {
    await memory.store.claim(
      `idem:create:${ADMIN_ID}:${KEY}`,
      JSON.stringify({
        state: 'pending',
        bodyHash: hash(JSON.stringify({ name: 'Ana' })),
      }),
      PENDING_TTL_SECONDS,
    );

    const result = await run(idempotent('create'), request());
    const err = appError(result);

    assert.equal(result.handled, false);
    assert.equal(err.statusCode, 409);
    assert.equal(err.details?.reason, 'requestInProgress');
  });

  it('refuses a key reused with a different body', async () => {
    await run(idempotent('create'), request({ body: { name: 'Ana' } }));

    const result = await run(
      idempotent('create'),
      request({ body: { name: 'Bia' } }),
    );

    assert.equal(result.handled, false);
    assert.equal(appError(result).statusCode, 400);
  });

  it('releases the key when the action fails, so a retry runs', async () => {
    const failed = await run(idempotent('create'), request(), 409);

    assert.equal(failed.status, 409);
    assert.equal(memory.data.size, 0);

    const retry = await run(idempotent('create'), request(), 201);

    assert.equal(retry.handled, true);
  });

  it('keeps one actor out of another actor’s key', async () => {
    await run(idempotent('create'), request());

    const other = await run(
      idempotent('create'),
      request({ adminId: OTHER_ADMIN_ID }),
    );

    assert.equal(other.handled, true);
    assert.equal(other.headers['Idempotent-Replay'], undefined);
  });

  it('keeps one scope out of another', async () => {
    await run(idempotent('create'), request());

    const other = await run(idempotent('draw'), request());

    assert.equal(other.handled, true);
  });

  it('passes a request without a key straight through', async () => {
    const result = await run(idempotent('create'), request({ key: null }));

    assert.equal(result.handled, true);
    assert.equal(memory.data.size, 0);
  });

  it('rejects a key that is not a UUID', async () => {
    const result = await run(
      idempotent('create'),
      request({ key: 'not-a-uuid' }),
    );

    assert.equal(result.handled, false);
    assert.equal(appError(result).statusCode, 400);
  });

  it('runs without a key when the store fails', async () => {
    idempotent = createIdempotency({
      store: {
        ...memory.store,
        claim: () => Promise.reject(new Error('Connection is closed.')),
      },
      warn: (message) => {
        warnings.push(message);
      },
    });

    const result = await run(idempotent('create'), request());

    assert.equal(result.handled, true);
    assert.equal(warnings.length, 1);
  });

  it('still answers when the record cannot be saved', async () => {
    idempotent = createIdempotency({
      store: {
        ...memory.store,
        save: () => Promise.reject(new Error('Connection is closed.')),
      },
      warn: (message) => {
        warnings.push(message);
      },
    });

    const result = await run(idempotent('create'), request(), 201);

    assert.equal(result.status, 201);
    assert.equal(warnings.length, 1);
  });
});
