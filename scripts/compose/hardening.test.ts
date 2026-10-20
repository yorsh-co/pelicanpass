import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Guards the container hardening of the production stack.
 *
 * Every service starts from the image's defaults, which are a writable root
 * filesystem, Docker's default capability set, no `no-new-privileges` and no
 * memory or process ceiling. Each one here narrows those to what it needs, and
 * the capability list is the review point: a service that needs another has to
 * add it below with its reason. See docs/infrastructure/container-containment.md.
 */

const ROOT = new URL('../../', import.meta.url);

interface Service {
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  user?: string;
  mem_limit?: string | number;
  pids_limit?: number;
  tmpfs?: string[];
  privileged?: boolean;
  logging?: { driver?: string; options?: Record<string, string> };
}

const services = (
  parse(readFileSync(new URL('compose.prod.yml', ROOT), 'utf8')) as {
    services: Record<string, Service | undefined>;
  }
).services;

interface Expectation {
  /** Capabilities added back after `cap_drop: [ALL]`, with the reason. */
  caps: Record<string, string>;
  /** Image-level user the service must run as, when the image allows it. */
  user?: string;
  /** Paths that must be writable `tmpfs`, since the root is read-only. */
  tmpfs?: string[];
  /** The service has a memory and a process ceiling. */
  limits?: boolean;
}

const EXPECTED: Record<string, Expectation> = {
  app: { caps: {}, tmpfs: ['/tmp'], limits: true },
  proxy: {
    caps: {
      NET_BIND_SERVICE:
        'binds :80 and :8080; the binary carries it as a file capability',
    },
    user: '65532:65532',
    tmpfs: ['/data', '/config'],
    limits: true,
  },
  cache: { caps: {}, limits: true },
  db: {
    caps: {
      CHOWN: 'entrypoint fixes the data directory ownership',
      DAC_OVERRIDE: 'entrypoint writes into it as root',
      FOWNER: 'entrypoint sets its mode',
      SETGID: 'entrypoint drops to the postgres group',
      SETUID: 'entrypoint drops to the postgres user',
    },
    tmpfs: ['/tmp', '/run/postgresql'],
    limits: true,
  },
  migrate: { caps: {}, user: 'node', tmpfs: ['/tmp'], limits: true },
  tunnel: { caps: {}, limits: true },
  vpn: { caps: {}, tmpfs: ['/tmp'], limits: true },
};

/** Path part of a `tmpfs` entry, which may carry `:options`. */
const tmpfsPath = (entry: string): string => entry.split(':')[0] ?? entry;

describe('production container hardening', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    describe(name, () => {
      const service = services[name];

      it('exists', () => {
        assert.ok(service);
      });

      it('has a read-only root filesystem', () => {
        assert.equal(service?.read_only, true);
      });

      it('drops every capability and adds back only what it needs', () => {
        const { cap_drop, cap_add = [] } = service ?? {};

        assert.deepEqual(cap_drop, ['ALL']);
        assert.deepEqual(
          [...cap_add].sort(),
          Object.keys(expected.caps).sort(),
        );
      });

      it('forbids gaining privileges', () => {
        assert.ok(service?.security_opt?.includes('no-new-privileges:true'));
        assert.notEqual(service?.privileged, true);
      });

      it('mounts a tmpfs on every path it must write outside volumes', () => {
        const mounted = (service?.tmpfs ?? []).map(tmpfsPath);

        for (const path of expected.tmpfs ?? []) {
          assert.ok(mounted.includes(path), `${name} needs tmpfs ${path}`);
        }
      });

      if (expected.user) {
        it(`runs as ${expected.user}`, () => {
          assert.equal(service?.user, expected.user);
        });
      }

      it('rotates its container log', () => {
        const { driver, options } = service?.logging ?? {};

        assert.equal(driver, 'json-file');
        assert.match(String(options?.['max-size']), /^\d+[mg]$/);
        assert.ok(Number(options?.['max-file']) >= 1);
      });

      if (expected.limits) {
        it('has a memory and a process ceiling', () => {
          assert.match(String(service?.mem_limit), /^\d+[mg]$/);
          assert.ok(Number(service?.pids_limit) > 0);
        });
      }
    });
  }
});
