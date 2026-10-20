import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rung } from './rows.fixture.ts';
import { renderReport } from './render.ts';

const rows = [
  rung({
    session: 's1',
    rung: 'raffle-s8-1',
    scale: 8,
    served_p95: 13.2,
    served_p99: 18,
  }),
  rung({
    session: 's1',
    rung: 'raffle-s16-1',
    scale: 16,
    thresholds_passed: false,
  }),
  rung({
    session: 's1',
    rung: 'raffle-s16-2',
    scale: 16,
    valid: false,
    invalid_reason: 'host busy (2.1 cores of other load: helium 0.90)',
    note: 'first try,\nafter a reboot',
  }),
];

describe('renderReport', () => {
  it('says so when nothing is recorded', () => {
    const text = renderReport([]);

    assert.match(text, /^# Load-test results\n/);
    assert.match(text, /No sessions recorded yet/);
    assert.ok(text.endsWith('\n'));
  });

  it('reports capacity, users and the event-wide estimate', () => {
    const text = renderReport(rows);

    assert.match(
      text,
      /\| dev-server \| ttttttt \(aaaaaaa\) \| raffle \| 8 \| 16 \| 4,000 \| 2 \| search not finished \|/,
    );
    assert.match(
      text,
      /\| dev-server \| ttttttt \(aaaaaaa\) \| 4,000 \| 4\.0 \| raffle \|/,
    );
  });

  it('keeps invalid rungs with their reason, and a note on one line', () => {
    const text = renderReport(rows);

    assert.match(
      text,
      /invalid: host busy \(2\.1 cores of other load: helium 0\.90\)/,
    );
    assert.match(text, /Note: first try, after a reboot/);
  });

  it('says so when no limiter run is recorded', () => {
    assert.match(renderReport(rows), /No limiter run recorded yet/);
  });

  it('lists limiter runs apart from capacity, one line per configuration', () => {
    const text = renderReport([
      ...rows,
      rung({
        session: 's2',
        rung: 'raffle-s1-1',
        scale: 1,
        ip_mode: 'single',
        thresholds_passed: false,
        rate_limited_rate: 0.83,
        flow_failed_rate: 0.83,
        captcha: 0,
        started_at: '2026-09-29T15:00:00Z',
      }),
      rung({
        session: 's3',
        rung: 'raffle-s1-1',
        scale: 1,
        ip_mode: 'single',
        trusted_ips_set: true,
        rate_limited_rate: 0,
        flow_failed_rate: 0,
        captcha: 0,
        started_at: '2026-09-29T17:00:00Z',
      }),
    ]);

    assert.match(
      text,
      /\| dev-server \| ttttttt \(aaaaaaa\) \| raffle \| single \| no \| — \| — \| 1 \| fail \| 83\.0% \| 0 \| 83\.0% \| 2026-09-29 \|/,
    );
    assert.match(
      text,
      /\| raffle \| single \| yes \| — \| — \| 1 \| pass \| 0\.0% \| 0 \| 0\.0% \|/,
    );
    // The capacity table still reads the spread rungs alone.
    assert.match(text, /\| raffle \| 8 \| 16 \| 4,000 \|/);
  });

  it('escapes a pipe inside a table cell', () => {
    const text = renderReport([rung({ rung: 'a|b', scale: 1 })]);

    assert.match(text, /\| a\\\|b \|/);
  });

  it('writes the same document whatever order the sessions arrive in', () => {
    const other = rows.map((r) => ({ ...r, session: 's0' }));

    assert.equal(
      renderReport([...rows, ...other]),
      renderReport([...other, ...rows]),
    );
  });
});
