/**
 * Typed readers over `process.env`.
 *
 * Kept apart from `env.ts` so a process that needs only a handful of values —
 * the standalone landing fallback — can parse them the same way without
 * importing a module that throws on every production secret it lacks.
 */

/**
 * Reads an environment variable, treating an empty value as absent.
 *
 * Docker Compose and `.env` files both surface an unset variable as `''`
 * rather than dropping it, so the two cases have to collapse before any
 * fallback logic runs.
 *
 * @param key - Name of the environment variable.
 */
export function read(key: string): string | undefined {
  const value = process.env[key];

  return value === '' ? undefined : value;
}

/**
 * Reads a required environment variable.
 *
 * Every value in `process.env` is `string | undefined`, and TypeScript cannot
 * see a separate presence check. Throwing here is what lets the exported
 * config built from it be typed as `string` rather than `string | undefined`.
 *
 * @param key - Name of the environment variable.
 * @returns The value.
 * @throws {Error} If the variable is unset or empty.
 */
export function required(key: string): string {
  const value = read(key);

  if (value === undefined) {
    throw new Error(`Missing environment variable: ${key}`);
  }

  return value;
}

/**
 * Reads an optional environment variable as a string.
 *
 * @param key - Name of the environment variable.
 * @param fallback - Value to use when unset or empty.
 */
export function optional(key: string, fallback: string): string {
  return read(key) ?? fallback;
}

/**
 * Reads an optional environment variable as a number.
 *
 * Throws on a value that is set but not numeric, for the same reason
 * {@link required} throws on a missing one: it is what makes the `number` on
 * the exported config true. `Number('abc')` is `NaN`, which would otherwise
 * flow into a port or a TTL and fail somewhere far from the typo.
 *
 * @param key - Name of the environment variable.
 * @param fallback - Value to use when unset or empty.
 * @throws {Error} If the variable is set to something non-numeric.
 */
export function numeric(key: string, fallback: number): number {
  const value = read(key);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Environment variable ${key} must be a number, received "${value}"`,
    );
  }

  return parsed;
}

/**
 * Reads an optional environment variable as a boolean.
 *
 * Only the two literals are accepted. A permissive parser that read `0`, `no`
 * or `off` as false would also read a typo as false, and the one consumer is
 * the switch that decides whether the pre-event curtain is up.
 *
 * @param key - Name of the environment variable.
 * @param fallback - Value to use when unset or empty.
 * @throws {Error} If the variable is set to anything but `true` or `false`.
 */
export function boolean(key: string, fallback: boolean): boolean {
  const value = read(key);

  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(
    `Environment variable ${key} must be "true" or "false", received "${value}"`,
  );
}

/**
 * Reads an optional environment variable as a duration in milliseconds.
 *
 * Accepts `90s`, `30m` or `4h` rather than a bare count. The consumers are the
 * two check-in windows, and `.env` is edited under time pressure on the day of
 * an event: `4h` cannot be misread, `240` can.
 *
 * @param key - Name of the environment variable.
 * @param fallback - Duration in milliseconds to use when unset or empty.
 * @throws {Error} If the variable is set to something unparseable.
 */
export function duration(key: string, fallback: number): number {
  const value = read(key);

  if (value === undefined) {
    return fallback;
  }

  const match = /^(\d+)([smh])$/.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];

  if (amount === undefined || unit === undefined) {
    throw new Error(
      `Environment variable ${key} must be a duration like "30m", "4h" or "90s", received "${value}"`,
    );
  }

  const scale = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;

  return Number(amount) * scale;
}

/**
 * Reads a required environment variable as an ISO-8601 instant.
 *
 * The offset is mandatory. Neither compose file sets `TZ`, so the container
 * runs UTC and `Date.parse('2026-09-13T19:00:00')` would resolve three hours
 * off local time — a check-in window that opens in the wrong part of the
 * afternoon, discovered by the queue rather than by the boot.
 *
 * @param key - Name of the environment variable.
 * @returns The instant, as epoch milliseconds.
 * @throws {Error} If the value carries no offset or is not a valid timestamp.
 */
export function timestamp(key: string): number {
  return parseInstant(key, required(key));
}

/**
 * Parses an ISO-8601 instant read from an environment variable.
 *
 * The check behind {@link timestamp}, for a variable that holds an instant as
 * part of a larger value.
 *
 * @param key - Name of the environment variable, for the error message.
 * @param value - The instant as written.
 * @returns The instant, as epoch milliseconds.
 * @throws {Error} If the value carries no offset or is not a valid timestamp.
 */
export function parseInstant(key: string, value: string): number {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(
      `Environment variable ${key} must carry an explicit UTC offset, as in "2026-09-13T19:00:00-03:00": the container clock is UTC`,
    );
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new Error(
      `Environment variable ${key} must be an ISO-8601 timestamp, received "${value}"`,
    );
  }

  return parsed;
}
