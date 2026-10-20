import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createTally,
  groupsOf,
  normalisePath,
  parseLine,
  renderSummary,
} from './traffic.ts';

import type { RequestLine } from './traffic.ts';

const T0 = Date.parse('2026-10-10T19:00:00Z');

const VENUE = '198.51.100.7';
const PHONE = '2804:14c:5b:1:aaaa:bbbb:cccc:dddd';

/** A log line as the HTTP logger writes it, with production's extra fields. */
const logLine = (
  url: string,
  options: { ip?: string; method?: string; status?: number; at?: number } = {},
): string =>
  JSON.stringify({
    level: 30,
    time: T0 + (options.at ?? 0),
    req: {
      id: 'r1',
      method: options.method ?? 'GET',
      url,
      userAgent: 'Mozilla/5.0 (iPhone)',
      cfIp: options.ip ?? VENUE,
      country: 'BR',
    },
    ip: options.ip ?? VENUE,
    res: { statusCode: options.status ?? 200 },
    responseTime: 4,
    msg: 'request completed',
  });

const request = (path: string, method = 'GET'): RequestLine => ({
  time: T0,
  method,
  path,
  ip: VENUE,
  status: 200,
});

describe('parseLine', () => {
  it('reads a completed request, dropping the query and the v4-mapped prefix', () => {
    assert.deepEqual(
      parseLine(logLine('/checkin?t=secret', { ip: `::ffff:${VENUE}` })),
      { time: T0, method: 'GET', path: '/checkin', ip: VENUE, status: 200 },
    );
  });

  it('skips other lines and garbage', () => {
    assert.equal(parseLine('{"msg":"Server running on port 3000"}'), null);
    assert.equal(parseLine('not json'), null);
    assert.equal(parseLine('null'), null);
  });
});

describe('groupsOf', () => {
  it('charges requests to the limiters docs/performance/rate-limiting.md names', () => {
    assert.deepEqual(groupsOf(request('/checkin')), ['web', 'checkin-entry']);
    assert.deepEqual(groupsOf(request('/pass')), ['web']);
    assert.deepEqual(groupsOf(request('/api/v1/checkin/ticket', 'POST')), [
      'api',
    ]);
  });

  it('leaves out what no per-IP limiter sees', () => {
    for (const path of [
      '/css/dist/main.css',
      '/js/pages/attendee/pass/index.js',
      '/healthz',
      '/api/v1/attendee/pass',
      '/api/v1/attendee/status',
      '/api/v1/survey',
      '/api/v1/whatsapp/webhook/s3cr3t',
    ]) {
      assert.deepEqual(groupsOf(request(path)), [], path);
    }
  });
});

describe('normalisePath', () => {
  it('masks identifiers and tokens, and keeps route words', () => {
    assert.equal(
      normalisePath('/admin/attendees/0b8a4c1e-2f3d-4e5f-8a9b-1c2d3e4f5a6b'),
      '/admin/attendees/:id',
    );
    assert.equal(
      normalisePath('/api/v1/whatsapp/webhook/Zx9_aB3cD4eF5gH6iJ7k'),
      '/api/v1/whatsapp/webhook/:id',
    );
    assert.equal(
      normalisePath('/api/v1/checkin/ticket'),
      '/api/v1/checkin/ticket',
    );
  });
});

describe('createTally', () => {
  const lines = [
    // One venue address checking in, three link entries in one minute.
    ...[0, 1, 2].flatMap((i) => [
      logLine('/checkin?t=a', { at: i * 1000 }),
      logLine('/checkin', { at: i * 1000 + 100 }),
      logLine('/css/dist/main.css', { at: i * 1000 + 200 }),
    ]),
    logLine('/api/v1/checkin/ticket', { method: 'POST', status: 400 }),
    logLine('/api/v1/checkin/verification', { method: 'POST', status: 400 }),
    logLine('/api/v1/attendee/status', { ip: PHONE, at: 60_000 }),
    logLine('/pass', { ip: PHONE, at: 60_500, status: 429 }),
    '{"msg":"Load shedding started"}',
  ];

  const tally = createTally();

  for (const line of lines) tally.add(line);

  const summary = tally.result();

  it('counts requests, minutes and addresses', () => {
    assert.equal(summary.lines, 14);
    assert.equal(summary.requests, 13);
    assert.equal(summary.from, '2026-10-10T19:00');
    assert.equal(summary.to, '2026-10-10T19:01');
    assert.deepEqual(summary.busiestMinute, {
      minute: '2026-10-10T19:00',
      requests: 11,
    });
    assert.equal(summary.addresses.total, 2);
    assert.equal(summary.addresses.v6, 1);
    assert.equal(summary.addresses.topShares[0], 11 / 13);
    assert.equal(summary.refused, 1);
  });

  it('finds the busiest address-minute per limiter', () => {
    assert.equal(summary.groups['checkin-entry'].peakPerAddressMinute, 6);
    assert.equal(summary.groups.web.requests, 7);
    assert.equal(summary.groups.api.requests, 2);
    assert.equal(summary.groups.web.overStrict, 0);
  });

  it('tells entry failures from verification failures', () => {
    assert.deepEqual(summary.entryFailures, {
      total: 1,
      peakPerMinute: 1,
      budget: 30,
    });
    assert.deepEqual(summary.verificationFailures, {
      total: 1,
      peakPerMinute: 1,
    });
  });

  it('renders with no address, user agent or token in it', () => {
    const text = renderSummary(summary);

    assert.match(text, /^# Traffic summary\n/);
    assert.match(text, /\| `rl:ip:checkin-entry` \| 6 \| 60\/min \| 6 \|/);
    assert.ok(!text.includes(VENUE));
    assert.ok(!text.includes('2804:14c'));
    assert.ok(!text.includes('iPhone'));
    assert.ok(!text.includes('t=a'));
    assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+/);
  });
});
