import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { surveyCoverage } from './survey-coverage.ts';

import type { SurveyOverview } from '../types/survey.ts';

const overview = (
  participant: Partial<SurveyOverview['audiences']['participant']> = {},
  volunteer: Partial<SurveyOverview['audiences']['volunteer']> = {},
): SurveyOverview => ({
  state: { open: true, reason: 'schedule' },
  override: null,
  opensAt: null,
  closesAt: null,
  audiences: {
    participant: {
      enabled: true,
      hasQuestions: true,
      responses: 0,
      ...participant,
    },
    volunteer: {
      enabled: true,
      hasQuestions: true,
      responses: 0,
      ...volunteer,
    },
  },
});

const checkins = [
  { attendeeRole: 'participant', checkedIn: 40 },
  { attendeeRole: 'volunteer', checkedIn: 8 },
];

describe('surveyCoverage', () => {
  it('pairs each audience with its check-ins and totals the answers', () => {
    const coverage = surveyCoverage(
      overview({ responses: 12 }, { responses: 3 }),
      checkins,
    );

    assert.deepEqual(coverage.rows, [
      { audience: 'participant', answered: 12, checkedIn: 40, off: false },
      { audience: 'volunteer', answered: 3, checkedIn: 8, off: false },
    ]);
    assert.equal(coverage.total, 15);
    assert.equal(coverage.visible, true);
  });

  it('keeps zero answered against zero checked in', () => {
    const coverage = surveyCoverage(overview(), [
      { attendeeRole: 'participant', checkedIn: 0 },
    ]);

    assert.equal(coverage.rows.at(0)?.answered, 0);
    assert.equal(coverage.rows.at(0)?.checkedIn, 0);
    assert.equal(coverage.visible, true);
  });

  it('lets responses exceed check-ins', () => {
    const coverage = surveyCoverage(overview({ responses: 45 }), checkins);

    assert.equal(coverage.rows.at(0)?.answered, 45);
    assert.equal(coverage.rows.at(0)?.checkedIn, 40);
  });

  it('counts a missing check-ins row as zero', () => {
    const coverage = surveyCoverage(overview({ responses: 2 }), []);

    assert.equal(coverage.rows.at(0)?.checkedIn, 0);
  });

  it('marks an audience off when switched off or without questions', () => {
    const coverage = surveyCoverage(
      overview({ enabled: false }, { hasQuestions: false, responses: 1 }),
      checkins,
    );

    assert.equal(coverage.rows.at(0)?.off, true);
    assert.equal(coverage.rows.at(1)?.off, true);
  });

  it('keeps a switched-off audience that has responses', () => {
    const coverage = surveyCoverage(
      overview({}, { enabled: false, responses: 4 }),
      checkins,
    );

    assert.equal(coverage.rows.at(1)?.off, true);
    assert.equal(coverage.rows.at(1)?.answered, 4);
    assert.equal(coverage.visible, true);
  });

  it('drops an idle volunteer row', () => {
    const coverage = surveyCoverage(
      overview({ responses: 1 }, { enabled: false }),
      checkins,
    );

    assert.deepEqual(
      coverage.rows.map((row) => row.audience),
      ['participant'],
    );
  });

  it('is not visible when everything is off and nothing was answered', () => {
    const coverage = surveyCoverage(
      overview({ enabled: false }, { enabled: false }),
      checkins,
    );

    assert.equal(coverage.visible, false);
    assert.equal(coverage.total, 0);
  });
});
