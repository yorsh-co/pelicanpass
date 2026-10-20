import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

interface Route {
  match?: { path?: string[]; host?: string[] }[];
  handle?: {
    handler: string;
    routes?: Route[];
    status_code?: string;
    health_checks?: { active?: { uri?: string; interval?: number } };
    load_balancing?: { try_duration?: number; try_interval?: number };
  }[];
}

const caddyfile = new URL('../Caddyfile', import.meta.url).pathname;

/**
 * Adapts the Caddyfile to JSON with the cached `caddy` image. Nothing is pulled
 * or started: `caddy adapt` only parses.
 *
 * @returns The adapted config, or `null` when Docker or the image is missing.
 */
const adapt = (): unknown => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '-v',
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      '-e',
      'SITE_HOST=site.test',
      '-e',
      'EDGE_SUBNET=10.0.0.0/24',
      '-e',
      'VPN_IP=10.0.0.2',
      '-e',
      'SERVER_NAME=test',
      'caddy:2.11.7@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772',
      'caddy',
      'adapt',
      '--config',
      '/etc/caddy/Caddyfile',
    ],
    { encoding: 'utf8' },
  );

  return result.status === 0 ? JSON.parse(result.stdout) : null;
};

/** Every route nested anywhere in the adapted config. */
const flatten = (routes: Route[]): Route[] =>
  routes.flatMap((route) => [
    route,
    ...flatten(route.handle?.flatMap((h) => h.routes ?? []) ?? []),
  ]);

const config = adapt() as {
  apps: { http: { servers: Record<string, { routes: Route[] }> } };
} | null;

describe(
  'Caddyfile',
  { skip: config === null && 'caddy image unavailable' },
  () => {
    const servers = Object.values(config?.apps.http.servers ?? {});
    const routes = servers.flatMap((s) => flatten(s.routes));

    it('refuses /readyz and /readyz/ on the public vhost', () => {
      const refused = routes.filter(
        (r) =>
          r.handle?.some((h) => h.handler === 'static_response') &&
          r.match?.some((m) => m.path?.includes('/readyz')),
      );

      assert.ok(refused.length > 0, 'no static response matches /readyz');
      assert.ok(
        refused.some((r) => r.match?.some((m) => m.path?.includes('/readyz/'))),
        '/readyz/ is not refused with /readyz',
      );
    });

    it('proxies /readyz and /readyz/ on the tailnet listener', () => {
      const proxied = routes.filter((r) =>
        r.match?.some(
          (m) => m.path?.includes('/readyz') && m.path.includes('/admin'),
        ),
      );

      assert.ok(proxied.length > 0);
      assert.ok(
        proxied.every((r) =>
          r.match?.every((m) => m.path?.includes('/readyz/')),
        ),
      );
    });

    describe('reverse proxies to app', () => {
      const SECOND = 1e9;
      const proxies = routes.flatMap(
        (r) => r.handle?.filter((h) => h.handler === 'reverse_proxy') ?? [],
      );

      it('finds both vhosts', () => {
        assert.equal(proxies.length, 2);
      });

      it('re-checks the upstream within a few seconds', () => {
        // Caddy's default is 30 s, and a check that lands while `app` is
        // restarting keeps every request at 503 until the next one.
        for (const proxy of proxies) {
          const interval = proxy.health_checks?.active?.interval ?? 30 * SECOND;

          assert.ok(
            interval <= 5 * SECOND,
            `interval ${String(interval / SECOND)}s`,
          );
        }
      });

      it('holds a request while no upstream is available instead of failing it', () => {
        for (const proxy of proxies) {
          const hold = proxy.load_balancing?.try_duration ?? 0;

          assert.ok(
            hold >= 3 * SECOND,
            `try_duration ${String(hold / SECOND)}s`,
          );
          assert.ok(proxy.load_balancing?.try_interval);
        }
      });
    });
  },
);
