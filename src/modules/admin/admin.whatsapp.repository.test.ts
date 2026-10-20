import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listCandidates, type Queryable } from './admin.whatsapp.repository.ts';

import type { WhatsappTemplateKey } from '../../constants/whatsapp-templates.ts';

/** A database that records the statement it is given and returns no rows. */
const fakeDb = () => {
  const calls: { sql: string; params: unknown[] }[] = [];

  const db = {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql, params });

      return Promise.resolve({ rows: [] });
    },
  } as unknown as Queryable;

  return { db, calls };
};

describe('listCandidates', () => {
  const cases: [WhatsappTemplateKey, boolean][] = [
    ['pax_survey_v1:pt_BR', true],
    ['vol_survey_v1:pt_BR', true],
    ['pax_wk_v1:pt_BR', false],
  ];

  for (const [key, checkedInOnly] of cases) {
    it(`passes checkedInOnly=${String(checkedInOnly)} for ${key}`, async () => {
      const { db, calls } = fakeDb();

      await listCandidates(db, 'participant', key);

      assert.equal(calls.length, 1);

      const [call] = calls;

      assert.deepEqual(call?.params.slice(2), [key, checkedInOnly]);
      assert.ok(call.sql.includes('a.checkin_complete'));
    });
  }
});
