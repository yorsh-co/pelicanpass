import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Guards which production services can reach the internet.
 *
 * `edge` and `web` are internal so that `proxy`, the one process facing the
 * tunnel and the tailnet, has no route out. The three services that dial out
 * (`tunnel`, `vpn` and `app`) join a network with a gateway: `egress` for the
 * two connectors, `app-egress` for `app` alone, so a compromised connector has
 * no route to `app:3000`.
 */

interface Compose {
  services: Record<string, { networks?: string[] | Record<string, unknown> }>;
  networks: Record<string, { internal?: boolean } | null>;
}

const compose = parse(
  readFileSync(new URL('../../compose.prod.yml', import.meta.url), 'utf8'),
) as Compose;

/** Names of the networks a service joins, whichever syntax it uses. */
const networksOf = (service: string): string[] => {
  const networks = compose.services[service]?.networks ?? [];

  return Array.isArray(networks) ? networks : Object.keys(networks);
};

describe('production network egress', () => {
  for (const name of ['edge', 'web', 'data']) {
    it(`${name} is internal`, () => {
      assert.equal(compose.networks[name]?.internal, true);
    });
  }

  for (const name of ['egress', 'app-egress']) {
    it(`${name} exists and is not internal`, () => {
      assert.ok(name in compose.networks);
      assert.notEqual(compose.networks[name]?.internal, true);
    });
  }

  for (const [service, network] of [
    ['tunnel', 'egress'],
    ['vpn', 'egress'],
    ['app', 'app-egress'],
  ] as const) {
    it(`${service} joins ${network}`, () => {
      assert.ok(networksOf(service).includes(network));
    });
  }

  it('keeps app off egress', () => {
    assert.ok(!networksOf('app').includes('egress'));
  });

  for (const name of ['tunnel', 'vpn', 'proxy', 'cache', 'db', 'migrate']) {
    it(`${name} does not join app-egress`, () => {
      assert.ok(!networksOf(name).includes('app-egress'));
    });
  }

  for (const name of ['proxy', 'cache', 'db', 'migrate']) {
    it(`${name} does not join egress`, () => {
      assert.ok(!networksOf(name).includes('egress'));
    });
  }

  it('lets only proxy, db, cache and migrate share a network with app', () => {
    const appNetworks = new Set(networksOf('app'));

    const peers: Record<string, string[]> = {};

    for (const name of Object.keys(compose.services)) {
      const shared = networksOf(name).filter((network) =>
        appNetworks.has(network),
      );

      if (name !== 'app' && shared.length > 0) peers[name] = shared;
    }

    assert.deepEqual(peers, {
      proxy: ['web'],
      db: ['data'],
      cache: ['data'],
      migrate: ['data'],
    });
  });

  it('keeps the proxy bridging edge and web', () => {
    assert.deepEqual(networksOf('proxy').sort(), ['edge', 'web']);
  });
});
