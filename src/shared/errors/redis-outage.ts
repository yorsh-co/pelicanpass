/**
 * Messages ioredis rejects a command with when the server cannot be reached,
 * as opposed to answering with an error. They are plain `Error`s, so the text
 * is all there is to match; the client's options in `shared/db/redis.ts`
 * (`enableOfflineQueue: false`, `commandTimeout`, `maxRetriesPerRequest`) are
 * what make each of these appear instead of a hang.
 */
const OUTAGE_MESSAGES = [
  "Stream isn't writeable",
  'Connection is closed',
  'Command timed out',
] as const;

/** Socket error codes of an unreachable server. */
const OUTAGE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

/**
 * Reports whether an error is Redis being unreachable, not Redis answering.
 *
 * A command rejected by the server (`WRONGTYPE`, `NOAUTH`) is a bug or a
 * misconfiguration and stays an unexpected error; only a connection that is
 * down, closed or too slow counts.
 *
 * @param err - Any thrown value.
 */
export const isRedisOutage = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;

  if (err.name === 'MaxRetriesPerRequestError') return true;

  const { code } = err as { code?: unknown };

  if (typeof code === 'string' && OUTAGE_CODES.has(code)) return true;

  return OUTAGE_MESSAGES.some((message) => err.message.includes(message));
};
