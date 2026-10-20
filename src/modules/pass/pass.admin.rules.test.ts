import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WELCOME_SCHEDULE_MAX_ENTRIES,
  WELCOME_TEXT_MAX_LENGTH,
} from '../../constants/pass.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';
import { readWelcomeScheduleSave } from './pass.admin.rules.ts';

import type { AdminRefusal } from '../../types/admin-refusal.ts';

const ZONE = 'America/Sao_Paulo';
const at = (iso: string): number => Date.parse(iso);

/**
 * Asserts the body is refused with a given reason.
 *
 * @param body - The request body.
 * @param reason - The refusal expected.
 */
const refuses = (body: unknown, reason: AdminRefusal): void => {
  assert.throws(
    () => readWelcomeScheduleSave(body, ZONE),
    (err: unknown) =>
      err instanceof ValidationError && err.details?.reason === reason,
  );
};

describe('readWelcomeScheduleSave', () => {
  it('reads a null schedule as handing back to .env', () => {
    assert.deepEqual(
      readWelcomeScheduleSave({ schedule: null, revision: 3 }, ZONE),
      { schedule: null, revision: 3 },
    );
  });

  it('reads an empty list as a schedule of its own', () => {
    assert.deepEqual(
      readWelcomeScheduleSave({ schedule: [], revision: 0 }, ZONE),
      { schedule: [], revision: 0 },
    );
  });

  it('reads times in the event zone and sorts the entries', () => {
    assert.deepEqual(
      readWelcomeScheduleSave(
        {
          revision: 1,
          schedule: [
            { phase: 'survey', at: '2026-10-03T18:00' },
            { phase: 'default', at: '2026-10-03T13:00' },
          ],
        },
        ZONE,
      ),
      {
        revision: 1,
        schedule: [
          { phase: 'default', at: at('2026-10-03T13:00:00-03:00') },
          { phase: 'survey', at: at('2026-10-03T18:00:00-03:00') },
        ],
      },
    );
  });

  it('refuses a body that is not a save', () => {
    for (const body of [
      undefined,
      null,
      'schedule',
      {},
      { revision: 0 },
      { schedule: null },
      { schedule: null, revision: -1 },
      { schedule: null, revision: 1.5 },
      { schedule: null, revision: '1' },
      { schedule: 'default@2026-10-03T13:00', revision: 0 },
    ]) {
      refuses(body, 'scheduleInvalid');
    }
  });

  it('refuses an unknown phase or a malformed entry', () => {
    refuses(
      { revision: 0, schedule: [{ phase: 'lunch', at: '2026-10-03T13:00' }] },
      'scheduleInvalid',
    );
    refuses({ revision: 0, schedule: [null] }, 'scheduleInvalid');
    refuses(
      { revision: 0, schedule: [{ phase: 'default', at: 1 }] },
      'scheduleInvalid',
    );
  });

  it('refuses a time that is malformed or not in the zone', () => {
    refuses(
      { revision: 0, schedule: [{ phase: 'default', at: '' }] },
      'scheduleTimeInvalid',
    );
    refuses(
      {
        revision: 0,
        schedule: [{ phase: 'default', at: '2026-10-03T13:00:00-03:00' }],
      },
      'scheduleTimeInvalid',
    );
    refuses(
      { revision: 0, schedule: [{ phase: 'default', at: '2026-02-30T13:00' }] },
      'scheduleTimeInvalid',
    );
  });

  it('reads a custom line, normalised, and sorts it with the others', () => {
    assert.deepEqual(
      readWelcomeScheduleSave(
        {
          revision: 2,
          schedule: [
            { phase: 'survey', at: '2026-10-03T18:00' },
            {
              phase: 'custom',
              text: '  Intervalo:\n lanche\u202E no pátio! ',
              at: '2026-10-03T15:30',
            },
          ],
        },
        ZONE,
      ),
      {
        revision: 2,
        schedule: [
          {
            phase: 'custom',
            text: 'Intervalo: lanche no pátio!',
            at: at('2026-10-03T15:30:00-03:00'),
          },
          { phase: 'survey', at: at('2026-10-03T18:00:00-03:00') },
        ],
      },
    );
  });

  it('drops a text sent on a built-in phase', () => {
    assert.deepEqual(
      readWelcomeScheduleSave(
        {
          revision: 0,
          schedule: [
            { phase: 'default', text: 'ignored', at: '2026-10-03T13:00' },
          ],
        },
        ZONE,
      ).schedule,
      [{ phase: 'default', at: at('2026-10-03T13:00:00-03:00') }],
    );
  });

  it('refuses a custom line without a text', () => {
    refuses(
      { revision: 0, schedule: [{ phase: 'custom', at: '2026-10-03T13:00' }] },
      'scheduleInvalid',
    );

    for (const text of ['', '   ', '\u202E\u200B']) {
      refuses(
        {
          revision: 0,
          schedule: [{ phase: 'custom', text, at: '2026-10-03T13:00' }],
        },
        'scheduleTextMissing',
      );
    }
  });

  it('refuses a custom line longer than the limit', () => {
    const entry = (length: number): unknown => ({
      revision: 0,
      schedule: [
        { phase: 'custom', text: 'á'.repeat(length), at: '2026-10-03T13:00' },
      ],
    });

    assert.doesNotThrow(() =>
      readWelcomeScheduleSave(entry(WELCOME_TEXT_MAX_LENGTH), ZONE),
    );
    refuses(entry(WELCOME_TEXT_MAX_LENGTH + 1), 'scheduleTextTooLong');
  });

  it('refuses two entries at the same time', () => {
    refuses(
      {
        revision: 0,
        schedule: [
          { phase: 'default', at: '2026-10-03T13:00' },
          { phase: 'survey', at: '2026-10-03T13:00' },
        ],
      },
      'scheduleDuplicateTime',
    );
  });

  it('refuses more entries than the limit', () => {
    const schedule = Array.from(
      { length: WELCOME_SCHEDULE_MAX_ENTRIES + 1 },
      (_, i) => ({
        phase: 'default',
        at: `2026-10-03T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      }),
    );

    refuses({ revision: 0, schedule }, 'scheduleTooLong');
    assert.doesNotThrow(() =>
      readWelcomeScheduleSave(
        { revision: 0, schedule: schedule.slice(1) },
        ZONE,
      ),
    );
  });
});
