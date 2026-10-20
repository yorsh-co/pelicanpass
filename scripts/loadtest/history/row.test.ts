import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLUMNS, resultsFromSummary, summaryMetrics } from './row.ts';

/** Trimmed from the 2026-09-28 raffle knee rung (`SCALE=16`, shedding off). */
const raffleKnee = {
  metrics: {
    served_duration: {
      avg: 1844.39,
      med: 1957.91,
      'p(95)': 3980.44,
      'p(99)': 5377.15,
      max: 6298.68,
      thresholds: { 'p(95)<500': true, 'p(99)<1500': true },
    },
    flow_failed: {
      passes: 0,
      fails: 26107,
      value: 0,
      thresholds: { 'rate==0': false },
    },
    shed: { passes: 0, fails: 30619, value: 0 },
    server_errors: {
      passes: 0,
      fails: 30619,
      value: 0,
      thresholds: { 'rate==0': false },
    },
    captcha_required: { count: 0, rate: 0, thresholds: { 'count==0': false } },
    http_reqs: { count: 30619, rate: 70.9 },
    iterations: { count: 26107, rate: 60.4 },
    dropped_iterations: { count: 2694, rate: 6.2 },
  },
  root_group: {},
  setup_data: { participants: ['session-token-that-must-not-leak'] },
};

const survey = {
  metrics: {
    served_duration: {
      'p(95)': 10.2,
      'p(99)': 12.1,
      max: 40,
      thresholds: { 'p(95)<500': false, 'p(99)<1500': false },
    },
    survey_submit_duration: {
      'p(95)': 4.84,
      thresholds: { 'p(95)<300': false },
    },
    iterations: { count: 8319, rate: 27.7 },
  },
};

describe('resultsFromSummary', () => {
  it('maps a failed rung that dropped arrivals', () => {
    const result = resultsFromSummary(raffleKnee, 'raffle', 99);

    assert.equal(result.k6_exit, 99);
    assert.equal(result.thresholds_passed, false);
    assert.equal(result.served_p95, 3980.44);
    assert.equal(result.served_p99, 5377.15);
    assert.equal(result.served_max, 6298.68);
    assert.equal(result.flow_failed_rate, 0);
    assert.equal(result.captcha, 0);
    assert.equal(result.reqs, 30619);
    assert.equal(result.iterations, 26107);
    assert.equal(result.dropped, 2694);
    assert.equal(result.dropped_rate, 2694 / (26107 + 2694));
  });

  it('has no phase trend for a phase without one', () => {
    assert.equal(
      resultsFromSummary(raffleKnee, 'raffle', 99).phase_trend_p95,
      null,
    );
  });

  it("takes the phase's own trend", () => {
    assert.equal(resultsFromSummary(survey, 'survey', 0).phase_trend_p95, 4.84);
  });

  it('passes when no threshold failed', () => {
    assert.equal(
      resultsFromSummary(survey, 'survey', 0).thresholds_passed,
      true,
    );
  });

  it('leaves a metric k6 never recorded empty, and counts no drops as zero', () => {
    const result = resultsFromSummary(survey, 'survey', 0);

    assert.equal(result.shed_rate, null);
    assert.equal(result.flow_shed_rate, null);
    assert.equal(result.dropped, 0);
    assert.equal(result.dropped_rate, 0);
  });

  it('never reads setup_data', () => {
    const result = resultsFromSummary(raffleKnee, 'raffle', 99);

    assert.ok(!JSON.stringify(result).includes('session-token'));
  });
});

describe('summaryMetrics', () => {
  it('refuses anything but a summary export', () => {
    for (const input of [null, [], {}, { metrics: [] }, 'metrics']) {
      assert.throws(() => summaryMetrics(input), /no "metrics" object/);
    }
  });
});

describe('COLUMNS', () => {
  it('opens with the schema and closes with the verdict', () => {
    assert.equal(COLUMNS[0], 'schema');
    assert.deepEqual(COLUMNS.slice(-2), ['valid', 'invalid_reason']);
  });

  it('has no duplicates', () => {
    assert.equal(new Set(COLUMNS).size, COLUMNS.length);
  });
});
