import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminTicketLimitService } from './admin.ticket-limit.service.ts';
import { ConflictError } from '../../shared/errors/app-error.ts';

import type { Request } from 'express';
import type { PoolClient } from 'pg';

import type { TicketLimitSetting } from '../../types/ticket-limit.ts';

/**
 * A client that answers the guard's three statements from fixed values and
 * records which ran, in order. The guard takes its client as an argument, so
 * no module needs replacing.
 */
const fakeClient = (setting: TicketLimitSetting | null, used: number) => {
  const statements: string[] = [];

  const client = {
    query: (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        statements.push('lock');

        return Promise.resolve({ rows: [] });
      }

      if (sql.includes('ticket_limit_state')) {
        statements.push('read');

        return Promise.resolve({ rows: setting ? [setting] : [] });
      }

      statements.push('count');

      return Promise.resolve({ rows: [{ n: String(used) }] });
    },
  } as unknown as PoolClient;

  return { client, statements };
};

const service = new AdminTicketLimitService({} as Request);

describe('AdminTicketLimitService.guard', () => {
  it('locks before it reads the setting, then counts', async () => {
    const { client, statements } = fakeClient(
      { scope: 'total', cap: 10, mode: 'hard' },
      3,
    );

    await service.guard(client, 'participant', 'xabc12');

    assert.deepEqual(statements, ['lock', 'read', 'count']);
  });

  it('locks even when there is no limit, and counts nothing', async () => {
    const { client, statements } = fakeClient(null, 0);

    assert.equal(await service.guard(client, 'participant', 'dabc12'), null);
    assert.deepEqual(statements, ['lock', 'read']);
  });

  it('returns null for a stored limit that is off', async () => {
    const { client } = fakeClient({ scope: 'off', cap: 5, mode: 'hard' }, 9);

    assert.equal(await service.guard(client, 'participant', 'dabc12'), null);
  });

  it('refuses a counted attendee at the cap in hard mode', async () => {
    const { client } = fakeClient({ scope: 'door', cap: 5, mode: 'hard' }, 5);

    await assert.rejects(
      service.guard(client, 'participant', 'dabc12'),
      (err: unknown) =>
        err instanceof ConflictError &&
        err.details?.reason === 'ticketLimitReached',
    );
  });

  it('allows the last ticket in hard mode and reports it reached', async () => {
    const { client } = fakeClient({ scope: 'door', cap: 5, mode: 'hard' }, 4);

    const limit = await service.guard(client, 'participant', 'dabc12');

    assert.ok(limit);
    assert.equal(limit.used, 5);
    assert.equal(limit.remaining, 0);
    assert.equal(limit.status, 'reached');
  });

  it('lets a counted attendee through in warn mode and reports over', async () => {
    const { client } = fakeClient({ scope: 'total', cap: 5, mode: 'warn' }, 5);

    const limit = await service.guard(client, 'participant', 'xabc12');

    assert.ok(limit);
    assert.equal(limit.used, 6);
    assert.equal(limit.remaining, -1);
    assert.equal(limit.status, 'over');
  });

  it('does not block or count a volunteer at the cap', async () => {
    const { client } = fakeClient({ scope: 'total', cap: 5, mode: 'hard' }, 5);

    const limit = await service.guard(client, 'volunteer', 'vabc12');

    assert.equal(limit?.used, 5);
  });

  it('does not block or count a typed code in door scope', async () => {
    const { client } = fakeClient({ scope: 'door', cap: 5, mode: 'hard' }, 5);

    const limit = await service.guard(client, 'participant', '7abc12');

    assert.equal(limit?.used, 5);
  });
});
