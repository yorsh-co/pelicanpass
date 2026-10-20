import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectExportRows } from './survey.export-query.ts';

describe('selectExportRows', () => {
  it('scopes the query to the event and audience it is given', async () => {
    let sql = '';
    let values: unknown[] = [];
    const rows = [
      {
        response_id: 'r1',
        submitted_on: '2026-09-13',
        survey_version: 'v1',
        answers: {},
      },
    ];
    const db = {
      query: (text: string, params: unknown[]) => {
        sql = text;
        values = params;

        return Promise.resolve({ rows });
      },
    };

    const result = await selectExportRows(db as never, 'evt-1', 'volunteer');

    assert.deepEqual(result, rows);
    assert.deepEqual(values, ['evt-1', 'volunteer']);
    assert.match(sql, /FROM survey_export/);
    assert.match(sql, /submitted_on::text/);
  });
});
