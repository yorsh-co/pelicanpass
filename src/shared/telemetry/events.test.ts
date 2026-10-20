import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import pg from '../db/postgres.ts';

import { enqueueEvent, flushEvents } from './events.ts';
import type { EventRow } from './events.ts';

interface QueryCall {
  text: string;
  values: unknown[];
}

/** Postgres' own rejection of a NUL in a text value. */
const nulError = (): Error =>
  Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
    code: '22021',
  });

const row = (overrides: Partial<EventRow> = {}): EventRow => ({
  severity: 'warn',
  kind: 'client_error',
  code: 'TypeError',
  fingerprint: 'fp',
  message: 'boom',
  route: '/x',
  statusCode: undefined,
  requestId: undefined,
  actorType: undefined,
  actorId: undefined,
  ip: '10.0.0.1',
  fields: undefined,
  ...overrides,
});

/** Column positions in the parameter list of one row (see `COLUMNS`). */
const MESSAGE = 5;
const CONTEXT = 13;
const WIDTH = 14;

/**
 * Stands in for the pool: rejects any statement whose parameters hold a NUL,
 * as Postgres does, and any whose message is listed in `failing`.
 */
const installPool = (failing: string[] = []) => {
  const calls: QueryCall[] = [];
  const written: unknown[][] = [];

  mock.method(pg, 'query', (text: string, values: unknown[]) => {
    calls.push({ text, values });

    for (let at = 0; at < values.length; at += WIDTH) {
      const rowValues = values.slice(at, at + WIDTH);

      if (JSON.stringify(rowValues).includes('\\u0000')) throw nulError();

      if (failing.includes(String(rowValues[MESSAGE]))) {
        throw Object.assign(new Error('constraint'), { code: '23514' });
      }
    }

    for (let at = 0; at < values.length; at += WIDTH) {
      written.push(values.slice(at, at + WIDTH));
    }

    return Promise.resolve({ rowCount: values.length / WIDTH });
  });

  return { calls, written };
};

describe('app_events sink', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  afterEach(async () => {
    await flushEvents(50);
    mock.restoreAll();
  });

  it('writes a clean row beside a NUL-bearing one, with the NUL stripped', async () => {
    const { written } = installPool();

    enqueueEvent(row({ message: 'clean' }));
    enqueueEvent(
      row({
        code: 'na\u0000me',
        message: 'nul\u0000byte',
        fields: { 'k\u0000ey': 'v\u0000al', n: 1 },
      }),
    );

    await flushEvents();

    assert.deepEqual(
      written.map((values) => values[MESSAGE]),
      ['clean', 'nulbyte'],
    );
    const [, nulRow = []] = written;

    assert.equal(nulRow[3], 'name');
    assert.deepEqual(JSON.parse(String(nulRow[CONTEXT])), {
      key: 'val',
      n: 1,
    });
  });

  it('writes the other rows when one fails for another reason', async () => {
    const { written, calls } = installPool(['bad']);

    enqueueEvent(row({ message: 'a' }));
    enqueueEvent(row({ message: 'bad' }));
    enqueueEvent(row({ message: 'b' }));

    await flushEvents();

    assert.deepEqual(
      written.map((values) => values[MESSAGE]),
      ['a', 'b'],
    );
    assert.equal(calls.length, 4);
  });

  it('writes a healthy batch in one statement', async () => {
    const { calls } = installPool();

    enqueueEvent(row({ message: 'a' }));
    enqueueEvent(row({ message: 'b' }));

    await flushEvents();

    assert.equal(calls.length, 1);
  });

  it('does not retry row by row when the database itself is unreachable', async () => {
    const calls: number[] = [];

    mock.method(pg, 'query', () => {
      calls.push(1);

      return Promise.reject(
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      );
    });

    enqueueEvent(row({ message: 'a' }));
    enqueueEvent(row({ message: 'b' }));

    await flushEvents();

    assert.equal(calls.length, 1);
  });
});
