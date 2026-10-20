import redis from '../shared/db/redis.ts';
import { logger } from '../shared/logger/logger.ts';

import { createIdempotency } from './idempotency.ts';

/**
 * Makes a route safe to repeat with an `Idempotency-Key`, recording claims in
 * Redis. See {@link createIdempotency} for the behaviour.
 */
export const idempotent = createIdempotency({
  store: {
    claim: async (key, value, ttlSeconds) =>
      (await redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK',

    get: (key) => redis.get(key),

    save: async (key, value, ttlSeconds) => {
      await redis.set(key, value, 'EX', ttlSeconds);
    },

    release: async (key) => {
      await redis.del(key);
    },
  },

  warn: (message, context) => {
    logger.warn(context, message);
  },
});
