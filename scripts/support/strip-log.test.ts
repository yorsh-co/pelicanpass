import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Runs `strip-log.sh` over fixtures modelled on the app's real log call sites
 * and asserts that no identifying value survives while the diagnostic fields
 * and the request id are left untouched.
 *
 * `jq` is a hard requirement of the script, so a host without it fails the
 * suite rather than skipping it.
 */

const SCRIPT = fileURLToPath(new URL('./strip-log.sh', import.meta.url));

const REQUEST_ID = '3f2b8c1e-5a47-4d0b-9c6e-0b1f2a3c4d5e';
const ATTENDEE_ID = '9a1c7e52-84d3-4f60-b2a9-7c05d1e8f3b4';
const ADMIN_ID = 'c4e8d2a1-6b35-4e97-8f10-2d9a5b7c3e68';
const TICKET_CODE = 'vab123';
const WAMID = 'wamid.HBgMNTUxMTkxMjM0NTY3OBUCABIYFA==';
const PG_SECRET_KEY = 731906458;

/** Every value below must be absent from the output. */
const IDENTIFYING = [
  '203.0.113.7',
  '198.51.100.23',
  '192.0.2.44',
  '2001:db8:85a3::8a2e:370:7334',
  '2001:db8::1',
  ATTENDEE_ID,
  ADMIN_ID,
  TICKET_CODE,
  WAMID,
  'maria@example.com',
  'Mozilla/5.0 (Pixel 8)',
  '5511912345678',
  '10.1.2.3',
  String(PG_SECRET_KEY),
];

/** Fixture lines. Objects are serialised; strings are written as they are. */
const FIXTURES: (object | string)[] = [
  {
    level: 30,
    time: 1760000000000,
    pid: 1,
    hostname: 'app-1',
    ip: '::ffff:203.0.113.7',
    req: {
      id: REQUEST_ID,
      method: 'POST',
      url: `/admin/attendees/${ATTENDEE_ID}/archive?page=2`,
      xff: '198.51.100.23, 192.0.2.44',
      cfIp: '198.51.100.23',
      country: 'BR',
      userAgent: 'Mozilla/5.0 (Pixel 8)',
    },
    res: { statusCode: 200 },
    responseTime: 12,
    msg: 'request completed',
  },
  {
    level: 40,
    time: 1760000000001,
    username: 'maria@example.com',
    ip: '203.0.113.7',
    code: 'LOGIN_REFUSED',
    msg: 'Admin sign-in refused',
  },
  {
    level: 30,
    time: 1760000000002,
    adminId: ADMIN_ID,
    attendeeId: ATTENDEE_ID,
    ticketCode: TICKET_CODE,
    source: 'editor',
    attendeeRole: 'participant',
    msg: 'Attendee created',
  },
  {
    level: 30,
    time: 1760000000003,
    to: '5511912345678',
    wamid: WAMID,
    sendId: 4021,
    outcome: 'sent',
    msg: 'WhatsApp template sent',
  },
  {
    level: 50,
    time: 1760000000004,
    err: {
      type: 'DatabaseError',
      message: 'duplicate key value violates unique constraint',
      detail: 'Key (attendee_phone)=(5511912345678) already exists.',
      code: '23505',
      stack:
        'error: duplicate key\n    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:283:98)\n    at /app/src/modules/admin/admin.service.ts:120:15',
    },
    errCode: '23505',
    msg: 'Attendee insert failed',
  },
  {
    level: 40,
    time: 1760000000005,
    clientMessage:
      'Could not save for maria@example.com, phone +55 11 91234-5678',
    url: `/pass/${ATTENDEE_ID}`,
    clientRelease: '1.0.0',
    msg: 'Client error reported',
  },
  {
    level: 20,
    time: 1760000000006,
    limiter: 'rl:ip',
    identifier: '203.0.113.7',
    method: 'GET',
    path: '/check-in',
    msg: 'Rate limiter consumed',
  },
  {
    level: 20,
    time: 1760000000007,
    limiter: 'rl:ip',
    identifier: '2001:db8:85a3::8a2e:370:7334',
    method: 'GET',
    path: '/check-in',
    msg: 'Rate limiter consumed',
  },
  {
    level: 50,
    time: 1760000000008,
    err: {
      type: 'DatabaseError',
      message: 'terminating connection due to administrator command',
      code: '57P01',
      client: { processID: 96, secretKey: PG_SECRET_KEY, host: 'db' },
    },
    msg: 'Unexpected Postgres pool error',
  },
  '[fatal] uncaught exception from 10.1.2.3: connect ECONNREFUSED',
  '',
  'truncated {"userAgent":"Mozilla/5.0 (Pixel 8)","ip":"2001:db8::1',
];

const input = FIXTURES.map((f) =>
  typeof f === 'string' ? f : JSON.stringify(f),
);

/** The parts of an output line the assertions read. */
interface Out {
  req?: { id?: string; url?: string; country?: string; method?: string };
  res?: { statusCode?: number };
  err?: { type?: string; code?: string; stack?: string; client?: unknown };
  url?: string;
  path?: string;
  _raw?: string;
  [key: string]: unknown;
}

/** Pipes `lines` through the script and returns its stdout lines. */
const strip = (lines: string[]): string[] => {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    input: `${lines.join('\n')}\n`,
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout.replace(/\n$/, '').split('\n');
};

describe('strip-log.sh', () => {
  it('runs on a host with jq installed', () => {
    const result = spawnSync('jq', ['--version'], { encoding: 'utf8' });

    assert.equal(result.status, 0, 'jq is required by strip-log.sh');
  });

  const output = strip(input);
  const parsed = output.map((line) => JSON.parse(line) as Out);

  /** The parsed output line at `index`. */
  const at = (index: number): Out => {
    const line = parsed[index];

    assert.ok(line, `no output line ${String(index)}`);

    return line;
  };

  it('emits one JSON line per input line, blank lines included', () => {
    assert.equal(output.length, input.length);
  });

  it('removes every identifying value', () => {
    const text = output.join('\n');

    for (const value of IDENTIFYING) {
      assert.ok(!text.includes(value), `${value} survived`);
    }
  });

  it('leaves the diagnostic fields unchanged', () => {
    for (const [index, fixture] of FIXTURES.entries()) {
      if (typeof fixture === 'string') continue;

      const kept = fixture as Record<string, unknown>;

      for (const key of [
        'level',
        'time',
        'msg',
        'code',
        'errCode',
        'method',
        'responseTime',
        'limiter',
        'outcome',
        'attendeeRole',
        'source',
        'pid',
        'hostname',
        'clientRelease',
      ]) {
        if (key in kept)
          assert.equal(at(index)[key], kept[key], `${String(index)}.${key}`);
      }
    }

    assert.equal(at(0).res?.statusCode, 200);
    assert.equal(at(0).req?.country, 'BR');
    assert.equal(at(0).req?.method, 'POST');
    assert.equal(at(4).err?.type, 'DatabaseError');
    assert.equal(at(4).err?.code, '23505');
    assert.equal(at(8).err?.code, '57P01');
  });

  it('replaces the pg client a pool error serialises, cancel key included', () => {
    assert.equal(at(8).err?.client, '[stripped]');
  });

  it('keeps the request id', () => {
    assert.equal(at(0).req?.id, REQUEST_ID);
  });

  it('masks ids in URLs without changing the route shape', () => {
    assert.equal(at(0).req?.url, '/admin/attendees/:id/archive?page=2');
    assert.equal(at(5).url, '/pass/:id');
    assert.equal(at(6).path, '/check-in');

    const [line] = strip([
      JSON.stringify({ url: '/api/v1/admin/attendees/123' }),
    ]);

    assert.equal(
      (JSON.parse(line ?? '') as Out).url,
      '/api/v1/admin/attendees/:id',
    );
  });

  it('masks a ticket code under an identifying key', () => {
    const lines = strip([
      JSON.stringify({ ticketCode: 'vab123' }),
      JSON.stringify({ ticketCode: 'dab123' }),
    ]);

    for (const line of lines) {
      assert.deepEqual(JSON.parse(line), { ticketCode: '[stripped]' });
    }
  });

  it('leaves ordinary words in free text unchanged', () => {
    const msg = 'denied delete device deploy domain values volume';
    const [line] = strip([JSON.stringify({ msg })]);

    assert.equal((JSON.parse(line ?? '') as { msg: string }).msg, msg);
  });

  it('keeps line and column numbers in stack frames', () => {
    const stack = at(4).err?.stack ?? '';

    assert.match(stack, /parser\.js:283:98/);
    assert.match(stack, /admin\.service\.ts:120:15/);
  });

  it('wraps a non-JSON line and scrubs it as text', () => {
    assert.deepEqual(at(9), {
      _raw: '[fatal] uncaught exception from [ip]: connect ECONNREFUSED',
    });
    assert.deepEqual(at(10), { _raw: '' });
  });
});
