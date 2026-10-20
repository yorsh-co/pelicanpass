// Named, not default: ioredis's default export is not typed as constructable
// under NodeNext resolution, though both forms work at runtime.
import { Redis } from 'ioredis';
import { env } from '../../config/env.ts';
import { logger } from '../logger/logger.ts';

/**
 * Shared Redis client.
 *
 * The three options below exist to bound what an unreachable Redis costs a
 * request. Measured on the stock ioredis defaults with the `cache` container
 * stopped: **`GET /checkin` did not respond within 60 seconds.**
 *
 * The reason it is that bad is that the cost compounds per *command*, not per
 * request. The entry path makes roughly eight sequential Redis calls — the web
 * limiter, three session reads in `resolveSessions`, the entry IP limiter, a
 * session read and write, the failure-budget read — and each one independently
 * waited out its own `maxRetriesPerRequest` cycle (20 attempts on a
 * `min(times × 50, 2000)`ms backoff, ~10.5s) before rejecting with
 * `MaxRetriesPerRequestError`.
 *
 * That matters beyond latency: the rate limiters' `insuranceLimiter` fallback
 * only engages once a command *rejects*, so until then every limit in the app
 * is neither enforced nor failed over — it is simply hanging.
 */
const redis = new Redis({
  ...env.redisConfig,
  lazyConnect: true,

  // Reject immediately when the connection is down rather than queueing until
  // the retry budget runs out, turning a Redis outage from a 60s hang into an
  // error the request can act on.
  //
  // **Invariant: connect before the first command.** Paired with `lazyConnect`,
  // an unconnected client rejects with `Stream isn't writeable and
  // enableOfflineQueue options is false`. server.ts awaits `redis.connect()`
  // before `app.listen`; any script importing this module must do the same.
  enableOfflineQueue: false,

  // Ceiling for the other failure mode: connected but not answering (BGSAVE
  // fork pause, swap, blocked instance). Nothing else covers it, because the
  // socket is still writable.
  commandTimeout: 1000,

  // Applies only to commands already in flight when the socket drops. Default
  // is 20, which is the ~10.5s above.
  maxRetriesPerRequest: 1,
});
export default redis;

let initialized = false;

export const initRedis = () => {
  if (initialized) return;

  redis.on('connect', () => {
    logger.info('Redis connecting...');
  });
  redis.on('ready', () => {
    logger.info('Redis ready');
  });
  redis.on('error', (err) => {
    logger.error({ err }, 'Redis error');
  });

  initialized = true;
};

export const checkRedis = async () => {
  try {
    await redis.ping();
    // `debug`: this now runs on every rules tick and every /readyz, so at
    // `info` a healthy dependency would out-log the traffic it is protecting.
    // The failure path below stays at `error`.
    logger.debug('Redis ping successful');
  } catch (err) {
    logger.error({ err }, 'Redis ping failed');
    throw err;
  }
};
