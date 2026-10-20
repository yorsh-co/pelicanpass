import { hash } from '../shared/utils/hash.ts';

import type { LimiterInfo } from './rate.middleware.ts';

/**
 * Digests a session ID or session cookie before it becomes a limiter key.
 *
 * The session store already keys Redis on digests so that the keyspace holds
 * no live credential; a limiter keyed on the raw ID would put one straight
 * back. A bare SHA-256 is enough for the same reason it is there: the IDs are
 * random UUIDs.
 *
 * @param id - The session ID or cookie value, if the request carried one.
 * @returns The digest, or null when there is nothing to key on.
 */
export const sessionKey = (id: string | null | undefined): string | null =>
  id ? hash(id) : null;

/**
 * The form of a limiter key that may be shown on the metrics panel.
 *
 * The panel lists each limiter's busiest keys to anyone holding
 * `metrics:read`, so a key that is a credential or names a person must not
 * reach it verbatim. Addresses stay readable because the fan-out column is
 * looked up by them, and the global budgets key on a constant. Everything else
 * is shortened to a digest prefix: enough to tell buckets apart and to follow
 * one across refreshes, nothing that can be replayed or read back.
 *
 * An unregistered limiter has no basis and falls through to the digest, the
 * safe default.
 *
 * @param basis - What the limiter keys on, from its registry entry.
 * @param key - What it keyed on.
 */
export const panelKey = (
  basis: LimiterInfo['basis'] | undefined,
  key: string,
): string =>
  basis === 'ip' || basis === 'global' ? key : hash(key).slice(0, 12);
