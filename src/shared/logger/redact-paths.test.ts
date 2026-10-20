import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import pg from 'pg';
import pino from 'pino';

import { REDACT_PATHS } from './redact-paths.ts';

const PHONE = '5511999990000';

/** A query failure as `pg` raises it, carrying row values in every field that can. */
const databaseError = (): pg.DatabaseError =>
  Object.assign(
    new pg.DatabaseError('new row violates check constraint', 0, 'error'),
    {
      code: '23514',
      constraint: 'attendees_team_check',
      detail: `Failing row contains (Probe Name, ${PHONE}).`,
      where: `SQL statement "INSERT INTO attendees VALUES ('${PHONE}')"`,
      internalQuery: `SELECT '${PHONE}'`,
    },
  );

/** A logger configured as `logger.ts` configures it, writing into memory. */
const capture = (): { log: pino.Logger; lines: string[] } => {
  const lines: string[] = [];
  const log = pino(
    { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => lines.push(line) },
  );

  return { log, lines };
};

describe('REDACT_PATHS on a Postgres error', () => {
  for (const [label, pick] of [
    ['the root logger', (log: pino.Logger) => log],
    ['a child logger, as req.log is', (log: pino.Logger) => log.child({})],
  ] as const) {
    it(`keeps row values out of ${label}`, () => {
      const { log, lines } = capture();

      pick(log).error({ err: databaseError() }, 'query failed');

      assert.equal(lines.length, 1);
      assert.ok(!lines[0]?.includes(PHONE), lines[0]);

      const { err } = JSON.parse(lines[0] ?? '{}') as {
        err: Record<string, unknown>;
      };

      assert.equal(err.detail, '[REDACTED]');
      assert.equal(err.where, '[REDACTED]');
      assert.equal(err.internalQuery, '[REDACTED]');
    });
  }

  it('leaves what diagnoses the failure readable', () => {
    const { log, lines } = capture();

    log.error({ err: databaseError() }, 'query failed');

    const { err } = JSON.parse(lines[0] ?? '{}') as {
      err: Record<string, unknown>;
    };

    assert.equal(err.code, '23514');
    assert.equal(err.constraint, 'attendees_team_check');
    assert.equal(err.message, 'new row violates check constraint');
  });
});

describe('REDACT_PATHS on a connection error', () => {
  const SECRET_KEY = 1234567891;

  it('censors the pg client but keeps what diagnoses the failure', () => {
    const { log, lines } = capture();
    const err = Object.assign(
      new Error('terminating connection due to administrator command'),
      {
        code: '57P01',
        severity: 'FATAL',
        client: { secretKey: SECRET_KEY, processID: 42 },
      },
    );

    log.error({ err }, 'Unexpected Postgres pool error');

    assert.ok(!lines[0]?.includes(String(SECRET_KEY)), lines[0]);
    assert.ok(lines[0]?.includes('"client":"[REDACTED]"'), lines[0]);

    const { err: logged } = JSON.parse(lines[0] ?? '{}') as {
      err: Record<string, unknown>;
    };

    assert.equal(logged.message, err.message);
    assert.equal(logged.code, '57P01');
    assert.equal(logged.type, 'Error');
    assert.equal(typeof logged.stack, 'string');
  });
});

describe('REDACT_PATHS on the Access assertion header', () => {
  it('censors the bearer credential', () => {
    const { log, lines } = capture();

    log.info(
      { req: { headers: { 'cf-access-jwt-assertion': 'header.payload.sig' } } },
      'request',
    );

    assert.ok(!lines[0]?.includes('header.payload.sig'), lines[0]);
  });
});
