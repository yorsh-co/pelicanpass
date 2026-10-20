import pkg from 'pg';
import { env } from '../../config/env.ts';
import { logger } from '../logger/logger.ts';

const { Pool } = pkg;

/**
 * Bounds an otherwise unlimited pool.
 *
 * `statement_timeout` is the load-bearing one. `completeCheckin` holds a
 * `FOR UPDATE` row lock for the length of its transaction, so a query that
 * never returns pins both the lock and the connection behind it — a denial of
 * service that costs an attacker nothing. Postgres enforces it server-side;
 * `query_timeout` is the client-side companion that stops the pool waiting on a
 * connection that has gone away entirely.
 *
 * `max` sits well under the server's `max_connections=100`, leaving headroom
 * for migrations and a psql session during the event.
 *
 * node-pg-migrate opens its own connection and is unaffected, so a long
 * migration is not at risk of being cut off at five seconds.
 */
const pg = new Pool({
  ...env.postgresConfig,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  query_timeout: 5_000,
});

pg.on('error', (err) => {
  logger.error({ err }, 'Unexpected Postgres pool error');
});

export default pg;
