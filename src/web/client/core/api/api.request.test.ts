import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { ApiError } from './api.error.ts';

/**
 * Browser stand-ins, installed before the module loads: `logger.ts` reads
 * `document.body.dataset` at import.
 *
 * `querySelector` returns null and is counted. `raiseChallengeGate` looks for
 * its gate before anything else, so the count says whether it was raised, and
 * finding nothing keeps its module-level `raised` flag clear between tests.
 */
let gateLookups = 0;
let timerClears = 0;

globalThis.document = {
  body: { dataset: {} },
  documentElement: { dataset: {} },
  querySelector: () => {
    gateLookups += 1;

    return null;
  },
} as unknown as Document;

// The timer methods resolve the globals at call time, so `mock.timers` drives
// them once enabled.
globalThis.window = {
  navigator: { onLine: true },
  location: { reload: () => undefined },
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => {
    timerClears += 1;
    clearTimeout(id);
  },
} as unknown as Window & typeof globalThis;

const { REQUEST_TIMEOUT_MS, request } = await import('./api.request.ts');

/** The rejection a browser gives an aborted request, without a reason. */
const aborted = (): DOMException =>
  new DOMException('The operation was aborted.', 'AbortError');

/** A request that never answers, until its signal aborts it. */
const hang: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(aborted());
    });
  });

/** Headers arrive at once; the body never does, until the signal aborts it. */
const stalledBody: typeof fetch = (_input, init) => {
  const body = new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => {
        controller.error(aborted());
      });
    },
  });

  return Promise.resolve(new Response(body, { status: 200 }));
};

/** Answers at once with `status` and, unless omitted, `body` as JSON. */
const respond =
  (status: number, body?: unknown): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      }),
    );

/**
 * Tracks whether `promise` has settled, and keeps its rejection handled while
 * the test advances the clock.
 */
const watch = <T>(promise: Promise<T>): { settled: () => boolean } => {
  let settled = false;

  promise.then(
    () => (settled = true),
    () => (settled = true),
  );

  return { settled: () => settled };
};

/** Lets pending promise callbacks run. `setImmediate` is not mocked. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Matches an `ApiError` by its code. */
const withCode =
  (code: string) =>
  (err: unknown): boolean =>
    (err as ApiError).code === code;

describe('request', () => {
  beforeEach(() => {
    gateLookups = 0;
    timerClears = 0;

    mock.timers.enable({ apis: ['setTimeout'] });

    // The failures below are logged on purpose; keep them off the test output.
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'error', () => undefined);
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it('times out a request that never answers at the deadline, not before', async () => {
    globalThis.fetch = hang;

    const pending = request('/api/v1/checkin/ticket');
    const state = watch(pending);

    mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(state.settled(), false);

    mock.timers.tick(1);
    await assert.rejects(pending, withCode('EDGE_TIMEOUT'));
  });

  it('lets a call replace the default deadline', async () => {
    globalThis.fetch = hang;

    const pending = request('/api/v1/admin/attendees', { timeoutMs: 30_000 });
    const state = watch(pending);

    mock.timers.tick(REQUEST_TIMEOUT_MS);
    await flush();
    assert.equal(state.settled(), false);

    mock.timers.tick(30_000 - REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, withCode('EDGE_TIMEOUT'));
  });

  it('does not raise the challenge gate for a timed-out admin request', async () => {
    globalThis.fetch = hang;

    const pending = request('/api/v1/admin/metrics');

    mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, withCode('EDGE_TIMEOUT'));
    assert.equal(gateLookups, 0);
  });

  it('still raises it for an admin request that could not connect', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));

    await assert.rejects(
      request('/api/v1/admin/metrics'),
      withCode('EDGE_UNREACHABLE'),
    );
    assert.equal(gateLookups, 1);
  });

  it('times out a body that stalls after the headers', async () => {
    globalThis.fetch = stalledBody;

    const pending = request('/api/v1/pass/band');

    mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, withCode('EDGE_TIMEOUT'));
  });

  it('reports a shed with its Retry-After', async () => {
    globalThis.fetch = respond(503, {
      error: 'Server busy',
      code: 'SERVICE_UNAVAILABLE',
      details: { retryAfterSeconds: 5 },
    });

    await assert.rejects(request('/api/v1/raffle/draws'), (err: unknown) => {
      const { code, status, details } = err as ApiError;

      assert.equal(code, 'SERVICE_UNAVAILABLE');
      assert.equal(status, 503);
      assert.equal(details?.retryAfterSeconds, 5);

      return true;
    });
  });

  it('returns a JSON body and clears its deadline', async () => {
    globalThis.fetch = respond(200, { data: { ok: true } });

    assert.deepEqual(await request('/api/v1/pass/band'), {
      data: { ok: true },
    });
    assert.equal(timerClears, 1);
  });

  it('returns nothing for a 204 and clears its deadline', async () => {
    globalThis.fetch = respond(204);

    assert.equal(await request('/api/v1/raffle/reset'), undefined);
    assert.equal(timerClears, 1);
  });
});
